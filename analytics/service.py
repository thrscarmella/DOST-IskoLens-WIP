"""
Analytics service used by the Node.js server (ANALYTICS_URL, default http://127.0.0.1:8001).
Run:  python service.py                                    (development)
      waitress-serve --listen=127.0.0.1:8001 service:app   (production)
It listens on 127.0.0.1 only: it is reached through the Node.js server, never directly.

Endpoints
  GET  /health       model status
  POST /predict      risk level, probabilities and top contributing factors per scholar
  POST /train        retrain from per-scholar rows sent by the web system ("Recalibrate Model")
  POST /diagnostic   correlations (Pearson, Spearman), chi-square with Cramer's V
  POST /forecast     time-based forecasts with MAE, RMSE, R2, MAPE, sMAPE
"""
import json
import math
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from flask import Flask, jsonify, request
from scipy import stats

from features import CATEGORICAL, NUMERIC

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "risk_model.joblib"
REPORT = HERE / "reports" / "risk_metrics.json"
MIN_ROWS = 30
app = Flask(__name__)
_cache = {"mtime": None, "bundle": None}
LABELS = {
    "birth_year": "Age at entry", "cycle_start": "Scholarship cycle", "n_below_requirement": "Terms below the GWA requirement",
    "n_failed": "Terms with a failing GWA", "max_consecutive_below": "Consecutive terms below requirement",
    "share_below_requirement": "Share of terms below requirement", "gwa_mean_grade": "Average GWA", "gwa_last_grade": "Latest GWA",
    "units_mean": "Units enrolled", "failed_subjects_total": "Failed or dropped subjects", "n_irregular_or_leave": "Irregular enrollment or leave",
    "n_inconsistent": "Inconsistent stipend releases", "n_pending": "Pending stipend releases", "sex": "Sex", "municipality": "Municipality",
    "program": "Scholarship program", "hei": "HEI",
}


def clean(o):
    """JSON-safe numbers (no NaN/inf)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return None if (math.isnan(o) or math.isinf(o)) else round(float(o), 4)
    if isinstance(o, np.integer):
        return int(o)
    return o


def bundle():
    if not MODEL.exists():
        return None
    mtime = MODEL.stat().st_mtime
    if _cache["mtime"] != mtime:   # picks up a newly trained model without restarting
        _cache.update(mtime=mtime, bundle=joblib.load(MODEL))
    return _cache["bundle"]


@app.get("/health")
def health():
    b = bundle()
    report = json.loads(REPORT.read_text()) if REPORT.exists() else None
    return jsonify(clean(dict(service="DOST-IskoLens analytics", model_trained=b is not None,
                   model_name=b["model_name"] if b else None, model_version=b["version"] if b else None,
                   classes=b["classes"] if b else None,
                   test_metrics=(report["results"][report["selected_model"]]["test_set_20_percent"] if report else None),
                   cv_metrics=(report["results"][report["selected_model"]]["cross_validation_5_fold"] if report else None),
                   comparison={k: v["test_set_20_percent"] for k, v in report["results"].items()} if report else None,
                   shap_top=report.get("shap_mean_abs_top10") if report else None,
                   class_counts=report.get("class_counts") if report else None,
                   notes=report.get("notes") if report else None)))


@app.post("/predict")
def predict():
    b = bundle()
    if b is None:
        return jsonify(error="No model has been trained yet."), 503
    body = request.get_json(silent=True) or {}
    rows = body.get("scholars")
    if not isinstance(rows, list) or not rows:
        return jsonify(error="Send {\"scholars\": [ {feature: value, ...}, ... ]}."), 422
    X = pd.DataFrame(rows).reindex(columns=b["features"])
    pipe = b["pipeline"]
    proba = pipe.predict_proba(X)
    factors = [[] for _ in rows]
    try:   # top contributing factors per scholar (SHAP), toward the predicted class
        import shap
        Xt = pipe.named_steps["prep"].transform(X)
        sv = shap.TreeExplainer(pipe.named_steps["model"]).shap_values(Xt)
        arr = np.array(sv)
        for i in range(len(rows)):
            k = int(np.argmax(proba[i]))
            contrib = arr[k][i] if arr.ndim == 3 and arr.shape[0] == len(b["classes"]) else (arr[i, :, k] if arr.ndim == 3 else arr[i])
            order = np.argsort(-np.abs(contrib))[:3]
            factors[i] = [{"feature": b["features"][j], "label": LABELS.get(b["features"][j], b["features"][j]),
                           "effect": "raises" if contrib[j] > 0 else "lowers", "weight": round(float(abs(contrib[j])), 4)} for j in order]
    except Exception:  # noqa: BLE001 - explanations are optional
        pass
    out = []
    for i, row in enumerate(rows):
        probs = {c: round(float(p), 4) for c, p in zip(b["classes"], proba[i])}
        out.append({"scholar_ref": row.get("scholar_ref"), "risk": max(probs, key=probs.get), "probabilities": probs, "top_factors": factors[i]})
    return jsonify(model_version=b["version"], predictions=out)


@app.post("/train")
def train_endpoint():
    from train_risk import NotEnoughData, train
    rows = (request.get_json(silent=True) or {}).get("scholars") or []
    table = pd.DataFrame(rows)
    if not len(table):
        return jsonify(error="No scholar records were sent."), 409
    for col in CATEGORICAL + NUMERIC + ["risk_label"]:
        if col not in table:
            table[col] = np.nan
    try:
        report = train(table)
    except NotEnoughData as err:
        return jsonify(error=f"Not enough data to train yet: {err}"), 409
    return jsonify(clean({"ok": True, "selected_model": report["selected_model"], "trained_at": report["trained_at"],
                          "class_counts": report["class_counts"], "notes": report["notes"],
                          "test_metrics": report["results"][report["selected_model"]]["test_set_20_percent"]}))


def cramers_v(table):
    chi2, p, dof, _ = stats.chi2_contingency(table)
    n = table.to_numpy().sum()
    r, k = table.shape
    v = math.sqrt(chi2 / (n * (min(r, k) - 1))) if min(r, k) > 1 and n else float("nan")
    return chi2, p, v


@app.post("/diagnostic")
def diagnostic():
    rows = (request.get_json(silent=True) or {}).get("scholars") or []
    df = pd.DataFrame(rows)
    if "risk_label" not in df:
        df["risk_label"] = None
    known = df[df["risk_label"].notna()].copy()
    if len(known) < MIN_ROWS:
        return jsonify(enough_data=False, scholars_with_outcome=len(known), minimum=MIN_ROWS)
    known["terminated"] = (known["risk_label"] == "High").astype(int)
    correlations = []
    for col in NUMERIC:
        x = pd.to_numeric(known.get(col), errors="coerce")
        ok = x.notna()
        if ok.sum() < 10 or x[ok].nunique() < 2:
            continue
        pr, pp = stats.pearsonr(x[ok], known.loc[ok, "terminated"])
        sr, sp = stats.spearmanr(x[ok], known.loc[ok, "terminated"])
        correlations.append({"factor": LABELS.get(col, col), "pearson_r": pr, "pearson_p": pp, "spearman_rho": sr, "spearman_p": sp, "n": int(ok.sum())})
    correlations.sort(key=lambda c: -abs(c["spearman_rho"] or 0))
    associations = []
    for col in CATEGORICAL:
        if col not in known or known[col].nunique() < 2:
            continue
        ct = pd.crosstab(known[col].fillna("Unknown"), known["terminated"])
        if ct.shape[1] < 2:
            continue
        chi2, p, v = cramers_v(ct)
        associations.append({"factor": LABELS.get(col, col), "chi_square": chi2, "p_value": p, "cramers_v": v, "categories": int(ct.shape[0])})
    associations.sort(key=lambda a: -(a["cramers_v"] or 0))
    report = json.loads(REPORT.read_text()) if REPORT.exists() else {}
    shap_top = [{"factor": LABELS.get(k, k), "importance": v} for k, v in (report.get("shap_mean_abs_top10") or {}).items()]
    return jsonify(clean({"enough_data": True, "scholars_with_outcome": len(known), "correlations": correlations,
                          "associations": associations, "shap_top": shap_top}))


@app.post("/forecast")
def forecast():
    from sklearn.linear_model import LinearRegression
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    body = request.get_json(silent=True) or {}
    out = {}
    for name, series in (body.get("series") or {}).items():
        df = pd.DataFrame(series)   # columns: group, year, value
        if not len(df) or df["year"].nunique() < 4:
            out[name] = {"enough_data": False, "years": int(df["year"].nunique()) if len(df) else 0, "minimum_years": 4}
            continue
        years = sorted(df["year"].unique())
        test_from = years[-2]   # time-based split: the last two years are held out
        actual, pred, next_rows = [], [], []
        for g, sub in df.groupby("group"):
            sub = sub.groupby("year")["value"].sum().reset_index()
            train_, test_ = sub[sub.year < test_from], sub[sub.year >= test_from]
            if len(train_) >= 2 and len(test_):
                m = LinearRegression().fit(train_[["year"]], train_["value"])
                actual += list(test_["value"]); pred += list(np.clip(m.predict(test_[["year"]]), 0, None))
            if len(sub) >= 2:
                full = LinearRegression().fit(sub[["year"]], sub["value"])
                nxt = int(sub.year.max()) + 1
                next_rows.append({"group": g, "year": nxt, "forecast": max(0.0, float(full.predict(pd.DataFrame({"year": [nxt]}))[0]))})
        a, p = np.array(actual, float), np.array(pred, float)
        nz = a != 0
        metrics = {"MAE": mean_absolute_error(a, p), "RMSE": math.sqrt(mean_squared_error(a, p)),
                   "R2": r2_score(a, p) if len(a) > 1 else None,
                   "MAPE_percent": float(np.mean(np.abs((a[nz] - p[nz]) / a[nz])) * 100) if nz.any() else None,
                   "sMAPE_percent": float(np.mean(2 * np.abs(p - a) / (np.abs(a) + np.abs(p) + 1e-9)) * 100), "test_points": int(len(a))} if len(a) else None
        out[name] = {"enough_data": True, "split": f"train before {test_from}, test {test_from}-{years[-1]}", "metrics": metrics,
                     "next_year": sorted(next_rows, key=lambda r: -r["forecast"])}
    return jsonify(clean(out))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8001)
