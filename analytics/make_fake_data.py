"""
Creates a FICTIONAL dataset in the exact format of the DOST data request
workbook, so the whole pipeline can be rehearsed before the real data arrives.
Run:  python make_fake_data.py --scholars 300 --out fake_dost_data.xlsx
Never mix this file with real records.
"""
import argparse
import random

from openpyxl import Workbook

MUNIS = ["Baganga", "Banaybanay", "Boston", "Caraga", "Cateel", "Governor Generoso", "Lupon", "Manay", "Mati City", "San Isidro", "Tarragona"]
HEIS = ["Davao Oriental State University", "DOSCST"]
HEADERS = {
    "1_Scholar_Profile": ["Scholar Ref No.", "Sex", "Birth Year", "Municipality of Origin", "Secondary School Graduated From", "Scholarship Program",
                          "Scholarship Cycle / Year Awarded", "Date of Scholarship Enrollment", "HEI Enrolled In", "HEI Campus", "HEI Location",
                          "Degree Program", "Current / Last Year Level", "Scholar Status", "Status Effective Date", "Remarks"],
    "2_Academic_Records": ["Scholar Ref No.", "Academic Year", "Semester", "Year Level", "GWA", "Grading Scale", "Academic Standing",
                           "Enrollment Status", "Units Enrolled", "Failed / Dropped Subjects", "Date Grades Submitted"],
    "3_Stipend_Disbursements": ["Scholar Ref No.", "Disbursement Period", "Amount (PHP)", "Disbursement Status", "Date Released", "Remarks"],
    "4_Graduation_Records": ["Scholar Ref No.", "Expected Graduation (AY)", "Actual Graduation Date", "Graduation Status", "Graduated On Time",
                             "Reason for Delay", "Latin Honors / Awards"],
    "5_Termination_Records": ["Scholar Ref No.", "Date of Termination", "Academic Year of Termination", "Semester of Termination",
                              "Ground for Termination", "HEI at Time of Termination", "Year Level at Termination", "Remarks"],
    "6_School_Applicants": ["Scholarship Cycle / Year", "Secondary School", "Municipality", "Scholarship Program", "No. of Applicants / Examinees",
                            "No. of Qualifiers", "No. of Awardees / Accepted", "Total Graduating Class Size"],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scholars", type=int, default=300)
    ap.add_argument("--out", default="fake_dost_data.xlsx")
    a = ap.parse_args()
    r = random.Random(7)
    wb = Workbook(); wb.remove(wb.active)
    sh = {name: wb.create_sheet(name) for name in HEADERS}
    for name, cols in HEADERS.items():
        sh[name].append(cols)
    for i in range(1, a.scholars + 1):
        ref = f"S-{i:04d}"
        start = r.randint(2016, 2024)
        muni = r.choice(MUNIS)
        ability = r.gauss(2.0, 0.45)                 # lower is better on the 1.00-5.00 scale
        stipend_problems = r.random() < 0.15
        years = min(2025 - start, 4)
        status, terminated, grad_status, on_time = "Active", False, "On Track", "N/A"
        records = []
        for t in range(max(1, years * 2)):
            lvl = t // 2 + 1
            gwa = round(min(max(ability + r.gauss(0, 0.25) + (0.3 if stipend_problems else 0), 1.0), 5.0), 2)
            records.append((f"{start + t // 2}-{start + t // 2 + 1}", "1st Semester" if t % 2 == 0 else "2nd Semester", lvl, gwa))
            if lvl <= 2 and gwa > 2.0 and len(records) >= 2 and records[-2][3] > 2.0 and r.random() < 0.6:
                terminated = True; break
            if gwa > 3.0 and r.random() < 0.5:
                terminated = True; break
        if terminated:
            status = "Terminated"
        elif years >= 4:
            status = "Graduated"
            delayed = (ability > 2.0 and r.random() < 0.7) or r.random() < 0.1
            grad_status, on_time = ("Delayed", "No") if delayed else ("Graduated", "Yes")
        sh["1_Scholar_Profile"].append([ref, r.choice(["Male", "Female"]), start - 18, muni, f"{muni} National High School", r.choice(["Merit", "RA 7687", "JLSS"]),
                                        f"{start}-{start + 1}", f"{start}-08-15", r.choice(HEIS), "Main Campus", "Mati City", "BS Information Technology",
                                        f"{records[-1][2]} Year" if records else "1st Year", status, "N/A", "N/A"])
        for ay, sem, lvl, gwa in records:
            sh["2_Academic_Records"].append([ref, ay, sem, f"{lvl} Year", gwa, "1.00-5.00 grade", "N/A", "Regular", 21, 1 if gwa > 3 else 0, "N/A"])
            sh["3_Stipend_Disbursements"].append([ref, f"{sem} {ay}", 20000, "Inconsistent" if stipend_problems and r.random() < 0.4 else "Released",
                                                  f"{ay[:4]}-09-10", "N/A"])
        if status in ("Graduated", "Active"):
            sh["4_Graduation_Records"].append([ref, f"{start + 4}-{start + 5}", f"{start + 4}-06-30" if status == "Graduated" else "N/A",
                                               grad_status, on_time, "Failed subjects" if grad_status == "Delayed" else "N/A", "N/A"])
        if terminated:
            ay = records[-1][0]
            sh["5_Termination_Records"].append([ref, f"{ay[5:]}-06-30", ay, records[-1][1], "Failure to meet the GWA requirement",
                                                "Davao Oriental State University", f"{records[-1][2]} Year", "N/A"])
    for year in range(2016, 2026):
        for muni in MUNIS:
            applicants = max(5, int(30 + (year - 2016) * 2 + r.gauss(0, 6)))
            qual = max(0, int(applicants * r.uniform(0.08, 0.2)))
            sh["6_School_Applicants"].append([f"{year}-{year + 1}", f"{muni} National High School", muni, "RA 7687", applicants, qual, qual, 200])
    wb.save(a.out)
    print(f"Wrote {a.out} with {a.scholars} fictional scholars")


if __name__ == "__main__":
    main()
