"""
Trains the risk model following the manuscript's plan:
  - 80/20 stratified train/test split
  - SMOTENC (SMOTE for numeric + categorical data) applied INSIDE each fold, on training data only
  - 5-fold stratified cross-validation
  - Random Forest (primary) compared with CART (Decision Tree baseline)
  - accuracy, precision, recall, F1 and AUC-ROC (one-vs-rest)
  - SHAP feature contributions for the explanations
  - early-warning features: each scholar's first two terms only (see features.py)

Run:   python train_risk.py --data DOST_data.xlsx
Output: models/risk_model.joblib, reports/risk_metrics.json
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from imblearn.over_sampling import SMOTENC
from imblearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_validate, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OrdinalEncoder
from sklearn.tree import DecisionTreeClassifier

from features import CATEGORICAL, NUMERIC, build_scholar_table, load_workbook

HERE = Path(__file__).resolve().parent
SEED = 42


def make_pipeline_for(model, n_cat, k_neighbors):
    prep = ColumnTransformer([
        ("cat", make_pipeline(SimpleImputer(strategy="most_frequent"),
                              OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)), CATEGORICAL),
        ("num", SimpleImputer(strategy="median", keep_empty_features=True), NUMERIC),
    ])
    return Pipeline([("prep", prep),
                     ("smote", SMOTENC(categorical_features=list(range(n_cat)), random_state=SEED, k_neighbors=k_neighbors)),
                     ("model", model)])


class NotEnoughData(Exception):
    pass


def train(table, save=True):
    """Trains on a per-scholar table (from the DOST workbook or from the web
    system's database) and returns the report. Raises NotEnoughData."""
    train_rows = table[table["risk_label"].notna()].copy()
    if len(train_rows) < 20 or train_rows["risk_label"].nunique() < 2:
        raise NotEnoughData(f"{len(train_rows)} scholar(s) with a known outcome; at least 20 across two or more outcomes are needed.")
    counts = train_rows["risk_label"].value_counts().to_dict()
    print("Scholars with an outcome (used for training):", counts)
    notes = []
    if min(counts.values()) < 30:
        notes.append("At least one class has fewer than 30 scholars; results are preliminary.")
    if min(counts.values()) < 8:
        # too few for SMOTE inside 5 folds: fall back to terminated vs not terminated
        train_rows["risk_label"] = np.where(train_rows["risk_label"] == "High", "High", "Not high")
        counts = train_rows["risk_label"].value_counts().to_dict()
        notes.append("Classes merged into High vs Not high because a class was too small.")
        print("Merged classes:", counts)

    X = train_rows[CATEGORICAL + NUMERIC]
    y = train_rows["risk_label"].astype(str)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, stratify=y, random_state=SEED)
    k = max(1, min(5, int(y_train.value_counts().min() * 0.8) - 1))   # SMOTE needs k < smallest class in a fold
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    multi = y.nunique() > 2
    scoring = {"accuracy": "accuracy", "precision": "precision_macro", "recall": "recall_macro", "f1": "f1_macro",
               "auc_roc": "roc_auc_ovr" if multi else "roc_auc"}
    candidates = {
        "Random Forest": RandomForestClassifier(n_estimators=300, random_state=SEED, class_weight=None),
        "CART (Decision Tree)": DecisionTreeClassifier(random_state=SEED, max_depth=6),
    }
    results = {}
    fitted = {}
    for name, model in candidates.items():
        pipe = make_pipeline_for(model, len(CATEGORICAL), k)
        cvres = cross_validate(pipe, X_train, y_train, cv=cv, scoring=scoring)
        pipe.fit(X_train, y_train)
        pred = pipe.predict(X_test)
        proba = pipe.predict_proba(X_test)
        auc = (roc_auc_score(y_test, proba, multi_class="ovr", labels=pipe.classes_) if multi
               else roc_auc_score((y_test == pipe.classes_[1]).astype(int), proba[:, 1]))
        results[name] = {
            "cross_validation_5_fold": {m: round(float(np.mean(cvres[f"test_{m}"])), 4) for m in scoring},
            "test_set_20_percent": {"accuracy": round(accuracy_score(y_test, pred), 4),
                                    "precision": round(precision_score(y_test, pred, average="macro", zero_division=0), 4),
                                    "recall": round(recall_score(y_test, pred, average="macro", zero_division=0), 4),
                                    "f1": round(f1_score(y_test, pred, average="macro", zero_division=0), 4),
                                    "auc_roc": round(float(auc), 4)},
        }
        fitted[name] = pipe
        print(f"{name}: CV F1 {results[name]['cross_validation_5_fold']['f1']}, test F1 {results[name]['test_set_20_percent']['f1']}")

    best = max(results, key=lambda n: results[n]["cross_validation_5_fold"]["f1"])
    model = fitted[best]
    names = CATEGORICAL + NUMERIC
    importance = {}
    if hasattr(model.named_steps["model"], "feature_importances_"):
        importance = dict(sorted(zip(names, map(float, model.named_steps["model"].feature_importances_)), key=lambda kv: -kv[1]))
    shap_top = {}
    try:
        import shap
        Xt = model.named_steps["prep"].transform(X_test)
        explainer = shap.TreeExplainer(model.named_steps["model"])
        values = explainer.shap_values(Xt)
        arr = np.abs(np.array(values))
        mean_abs = arr.mean(axis=tuple(i for i in range(arr.ndim) if arr.shape[i] != len(names)))
        shap_top = dict(sorted(zip(names, map(float, mean_abs)), key=lambda kv: -kv[1])[:10])
    except Exception as err:  # noqa: BLE001
        notes.append(f"SHAP summary skipped: {err}")

    version = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if save:
        (HERE / "models").mkdir(exist_ok=True)
        joblib.dump({"pipeline": model, "features": names, "classes": list(model.classes_), "model_name": best, "version": version},
                    HERE / "models" / "risk_model.joblib")
    report = {"trained_at": version, "selected_model": best, "class_counts": counts, "split": "80/20 stratified",
              "cross_validation": "5-fold stratified, SMOTENC inside each fold (training data only)", "notes": notes,
              "results": results, "feature_importance": importance, "shap_mean_abs_top10": shap_top,
              "scholars_without_outcome_to_score": int(table["risk_label"].isna().sum())}
    if save:
        (HERE / "reports").mkdir(exist_ok=True)
        (HERE / "reports" / "risk_metrics.json").write_text(json.dumps(report, indent=2))
        print(f"Selected: {best}. Saved models/risk_model.joblib and reports/risk_metrics.json")
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="Workbook in the DOST data request format")
    args = ap.parse_args()
    try:
        train(build_scholar_table(load_workbook(args.data)))
    except NotEnoughData as err:
        raise SystemExit(f"Not enough data: {err}")


if __name__ == "__main__":
    main()
