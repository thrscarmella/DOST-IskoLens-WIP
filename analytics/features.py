"""
Builds one row per scholar from the DOST Davao Oriental data request workbook
(the six sheets of DOST-IskoLens_Data_Request_Template.xlsx), ready for training.

Label rule (state this in Chapter 3; confirm with the adviser):
  High risk     = scholar was terminated
  Moderate risk = graduation delayed / at risk of delay, or not graduated on time
  Low risk      = graduated on time
  Active scholars without an outcome yet are NOT used for training; they are the
  ones the trained model scores.
Early-warning design (avoids leakage): every scholar is described only by their
first WINDOW terms (default 2 = first year), the same for everyone. Counts over
the whole scholarship (number of terms, current year level) are NOT used,
because a terminated scholar naturally has fewer of them, which would let the
model read the answer instead of learning warning signs.
"""
import re

import numpy as np
import pandas as pd

SHEETS = {
    "profile": "1_Scholar_Profile", "academic": "2_Academic_Records", "stipends": "3_Stipend_Disbursements",
    "graduation": "4_Graduation_Records", "termination": "5_Termination_Records", "applicants": "6_School_Applicants",
}
REF = "Scholar Ref No."
CATEGORICAL = ["sex", "municipality", "program", "hei"]
NUMERIC = ["birth_year", "cycle_start", "n_below_requirement", "n_failed", "max_consecutive_below",
           "share_below_requirement", "gwa_mean_grade", "gwa_last_grade", "units_mean", "failed_subjects_total",
           "n_irregular_or_leave", "n_inconsistent", "n_pending"]
WINDOW = 2   # first two terms (first year) of every scholar
SEM_ORDER = {"1st semester": 1, "2nd semester": 2, "summer": 3}


def load_workbook(path):
    """All six sheets as DataFrames; 'N/A' and blanks become missing values."""
    xl = pd.read_excel(path, sheet_name=None, dtype=object)
    out = {}
    for key, name in SHEETS.items():
        df = xl.get(name, pd.DataFrame())
        df = df.replace({"N/A": np.nan, "n/a": np.nan, "NA": np.nan, "": np.nan})
        out[key] = df.dropna(how="all")
    return out


def start_year(value):
    m = re.search(r"(\d{4})", str(value or ""))
    return int(m.group(1)) if m else np.nan


def year_level(value):
    m = re.search(r"\d", str(value or ""))
    return int(m.group(0)) if m else np.nan


def standing(gwa, scale, level, rule):
    """Same year-level rule as the web system (revised BPMN)."""
    try:
        g = float(gwa)
    except (TypeError, ValueError):
        return None
    is_percent = "percent" in str(scale).lower() or g > 5
    lower = level in (1, 2)
    if is_percent:
        req = rule["pct_required_lower"] if lower else rule["pct_passing"]
        return "Good Standing" if g >= req else ("Probation" if g >= rule["pct_passing"] else "Failed")
    req = rule["grade_required_lower"] if lower else rule["grade_passing"]
    return "Good Standing" if g <= req else ("Probation" if g <= rule["grade_passing"] else "Failed")


DEFAULT_RULE = {"grade_required_lower": 2.00, "grade_passing": 3.00, "pct_required_lower": 85, "pct_passing": 75}


def label_for(row):
    status = str(row.get("status") or "").strip().lower()
    grad = str(row.get("graduation_status") or "").strip().lower()
    on_time = str(row.get("graduated_on_time") or "").strip().lower()
    if status == "terminated" or row.get("terminated"):
        return "High"
    if grad in ("delayed", "at risk of delay") or on_time == "no":
        return "Moderate"
    if status == "graduated" or grad == "graduated":
        return "Low"
    return None   # no outcome yet: scored, not trained on


def build_scholar_table(sheets, rule=DEFAULT_RULE, window=WINDOW):
    p = sheets["profile"].copy()
    rows = []
    acad = sheets["academic"].copy()
    if len(acad):
        acad["_ay"] = acad["Academic Year"].map(start_year)
        acad["_sem"] = acad["Semester"].astype(str).str.lower().map(SEM_ORDER).fillna(1)
        acad["_lvl"] = acad["Year Level"].map(year_level)
        acad = acad.sort_values([REF, "_ay", "_sem"])
    term = sheets["termination"].set_index(REF) if len(sheets["termination"]) else pd.DataFrame()
    grad = sheets["graduation"].set_index(REF) if len(sheets["graduation"]) else pd.DataFrame()
    sti = sheets["stipends"]
    for _, s in p.iterrows():
        ref = s[REF]
        r = {"scholar_ref": ref, "sex": s.get("Sex"), "municipality": s.get("Municipality of Origin"),
             "program": s.get("Scholarship Program"), "hei": s.get("HEI Enrolled In"),
             "birth_year": pd.to_numeric(s.get("Birth Year"), errors="coerce"),
             "cycle_start": start_year(s.get("Scholarship Cycle / Year Awarded")),
             "year_level": year_level(s.get("Current / Last Year Level")), "status": s.get("Scholar Status")}
        t = term.loc[ref] if len(term) and ref in term.index else None
        if isinstance(t, pd.DataFrame):
            t = t.iloc[-1]
        r["terminated"] = t is not None
        g = grad.loc[ref] if len(grad) and ref in grad.index else None
        if isinstance(g, pd.DataFrame):
            g = g.iloc[-1]
        r["graduation_status"] = g.get("Graduation Status") if g is not None else None
        r["graduated_on_time"] = g.get("Graduated On Time") if g is not None else None
        a = acad[acad[REF] == ref] if len(acad) else acad
        a = a.head(window) if len(a) else a   # same observation window for everyone
        st = [standing(row["GWA"], row.get("Grading Scale", ""), row["_lvl"], rule) for _, row in a.iterrows()]
        below = [x in ("Probation", "Failed") for x in st]
        run = best = 0
        for b in below:
            run = run + 1 if b else 0
            best = max(best, run)
        grade_rows = a[~a.get("Grading Scale", pd.Series(dtype=str)).astype(str).str.lower().str.contains("percent")] if len(a) else a
        gw = pd.to_numeric(grade_rows["GWA"], errors="coerce") if len(grade_rows) else pd.Series(dtype=float)
        enr = a["Enrollment Status"].astype(str).str.lower() if len(a) and "Enrollment Status" in a else pd.Series(dtype=str)
        r.update({
            "n_terms": len(a), "n_below_requirement": int(sum(below)), "n_failed": int(sum(x == "Failed" for x in st)),
            "max_consecutive_below": best, "share_below_requirement": (sum(below) / len(a)) if len(a) else np.nan,
            "gwa_mean_grade": gw.mean() if len(gw) else np.nan, "gwa_last_grade": gw.iloc[-1] if len(gw) else np.nan,
            "units_mean": pd.to_numeric(a.get("Units Enrolled"), errors="coerce").mean() if len(a) else np.nan,
            "failed_subjects_total": pd.to_numeric(a.get("Failed / Dropped Subjects"), errors="coerce").sum() if len(a) else 0,
            "n_irregular_or_leave": int(enr.str.contains("irregular|leave|loa").sum()) if len(enr) else 0,
        })
        mine = sti[sti[REF] == ref].head(window) if len(sti) else sti
        status_col = mine["Disbursement Status"].astype(str).str.lower() if len(mine) else pd.Series(dtype=str)
        r.update({"n_disbursements": len(mine), "n_inconsistent": int((status_col == "inconsistent").sum()),
                  "n_pending": int((status_col == "pending").sum())})
        r["risk_label"] = label_for(r)
        rows.append(r)
    return pd.DataFrame(rows)
