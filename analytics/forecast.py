"""
Forecasts with a TIME-BASED split (not random): train on earlier cycles,
test on the latest ones. Metrics: MAE, RMSE, R², MAPE (zeros excluded) and sMAPE.

Run:   python forecast.py --data DOST_data.xlsx --test-from 2024
Output: reports/forecast_metrics.json
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from features import load_workbook, start_year

HERE = Path(__file__).resolve().parent


def metrics(actual, predicted):
    actual, predicted = np.asarray(actual, float), np.asarray(predicted, float)
    nz = actual != 0
    return {"MAE": round(float(mean_absolute_error(actual, predicted)), 3),
            "RMSE": round(float(np.sqrt(mean_squared_error(actual, predicted))), 3),
            "R2": round(float(r2_score(actual, predicted)), 3) if len(actual) > 1 else None,
            "MAPE_percent": round(float(np.mean(np.abs((actual[nz] - predicted[nz]) / actual[nz])) * 100), 2) if nz.any() else None,
            "sMAPE_percent": round(float(np.mean(2 * np.abs(predicted - actual) / (np.abs(actual) + np.abs(predicted) + 1e-9)) * 100), 2),
            "test_points": int(len(actual))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--test-from", type=int, default=2024, help="First cycle year used for testing")
    args = ap.parse_args()
    apps = load_workbook(args.data)["applicants"].copy()
    apps["year"] = apps["Scholarship Cycle / Year"].map(start_year)
    for col in ["No. of Applicants / Examinees", "No. of Qualifiers"]:
        apps[col] = pd.to_numeric(apps[col], errors="coerce").fillna(0)
    out = {"split": f"train < {args.test_from} <= test", "series": {}}
    for target, label in [("No. of Applicants / Examinees", "applicants_per_municipality"), ("No. of Qualifiers", "qualifiers_per_municipality")]:
        series = apps.groupby(["Municipality", "year"])[target].sum().reset_index()
        actual_all, pred_all = [], []
        for muni, g in series.groupby("Municipality"):
            train, test = g[g.year < args.test_from], g[g.year >= args.test_from]
            if len(train) < 3 or not len(test):
                continue
            m = LinearRegression().fit(train[["year"]], train[target])
            pred = np.clip(m.predict(test[["year"]]), 0, None)
            actual_all += list(test[target]); pred_all += list(pred)
        out["series"][label] = metrics(actual_all, pred_all) if actual_all else {"note": "not enough yearly data"}
    (HERE / "reports").mkdir(exist_ok=True)
    (HERE / "reports" / "forecast_metrics.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
