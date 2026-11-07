"""
v3 API test suite, run unchanged in substance against the v4 Node.js server.
Run:  cd server && python3 -m pytest tests/contract -q
"""
import io
import os
import sys
from datetime import date, timedelta, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import node_harness as H  # noqa: E402

BASE = None


class _App:
    def test_client(self):
        return H.HttpClient(BASE)


app = _App()


class Client:
    def __init__(self):
        self.c = app.test_client()
        self.csrf = self.c.get("/api/auth/csrf").get_json()["csrf"]

    def req(self, method, url, json=None, **kw):
        headers = kw.pop("headers", {})
        headers["X-CSRF-Token"] = self.csrf
        r = getattr(self.c, method)(url, json=json, headers=headers, **kw)
        body = r.get_json(silent=True)
        if body and body.get("csrf"):
            self.csrf = body["csrf"]
        return r.status_code, body

    def login(self, email, password):
        return self.req("post", "/api/auth/login", {"email": email, "password": password})


def setup_module(_=None):
    global BASE
    H.cli("init-db")
    H.cli("create-admin", "--email", "admin@test.ph", "--first-name", "Ana", "--last-name", "Admin",
          "--username", "admin", "--password", "Admin1234")
    BASE = H.start_server()


def lookups(client):
    _, body = client.req("get", "/api/lookups")
    muni = next(m for m in body["municipalities"] if m["name"] == "Mati City")
    school = next(s for s in body["schools"] if s["municipality_id"] == muni["id"])
    return body, muni, school


def scholar_payload(client, **over):
    body, muni, school = lookups(client)
    data = {"gender": "Male",
            "birth_date": "2006-03-15", "mobile_number": "09171234567", "email": "juan@example.com",
            "program": body["programs"][0]["id"], "cycle": body["cycles"][1]["id"], "municipality": muni["id"],
            "secondary_school": school["id"], "enrollment_date": "2024-08-12", "hei": body["heis"][0]["id"],
            "degree_program": "BS Information Technology", "year_level": 1}
    data.update(over)
    return data


def test_auth_signup_approval_lockout_and_rbac():
    anon = Client()
    # CSRF required
    r = app.test_client().post("/api/auth/login", json={"email": "x", "password": "y"})
    assert r.status_code == 403
    # Signup -> pending
    code, body = anon.req("post", "/api/auth/signup", {
        "first_name": "Olive", "last_name": "Officer", "email": "olive@test.ph", "username": "olive",
        "password": "Officer123", "confirm_password": "Officer123", "privacy_consent": True})
    assert code == 201, body
    token = body["status_token"]
    assert anon.req("get", f"/api/auth/signup-status?token={token}")[1]["status"] == "pending"
    assert anon.login("olive@test.ph", "Officer123")[0] == 403
    # Weak password + duplicate email rejected
    assert anon.req("post", "/api/auth/signup", {"first_name": "A", "last_name": "B", "email": "olive@test.ph",
                                                 "username": "zzz", "password": "short", "confirm_password": "short",
                                                 "privacy_consent": True})[0] in (409, 422)

    admin = Client()
    assert admin.login("admin@test.ph", "Admin1234")[0] == 200
    _, users = admin.req("get", "/api/users?tab=pending")
    olive_id = users["users"][0]["id"]
    assert admin.req("post", f"/api/users/{olive_id}/approve")[0] == 200
    assert anon.req("get", f"/api/auth/signup-status?token={token}")[1]["status"] == "approved"

    officer = Client()
    assert officer.login("olive", "Officer123")[0] == 200
    # RBAC: officer cannot use admin APIs or pages
    assert officer.req("get", "/api/users")[0] == 403
    assert officer.req("get", "/api/audit-logs")[0] == 403
    assert officer.c.get("/pages/user-management.html").status_code == 302
    assert app.test_client().get("/pages/dashboard.html").status_code == 302

    # Lockout after 5 failures, admin unlock
    bad = Client()
    for _ in range(4):
        assert bad.login("olive@test.ph", "wrong")[0] == 401
    assert bad.login("olive@test.ph", "wrong")[0] == 423
    assert bad.login("olive@test.ph", "Officer123")[0] == 423
    assert officer.req("get", "/api/auth/me")[0] == 401  # locked account loses its session
    assert admin.req("post", f"/api/users/{olive_id}/unlock")[0] == 200
    assert bad.login("olive@test.ph", "Officer123")[0] == 200


def test_admin_creates_user_with_invite_and_reset_flow():
    admin = Client()
    admin.login("admin@test.ph", "Admin1234")
    code, body = admin.req("post", "/api/users", {"first_name": "Ben", "last_name": "New", "email": "ben@test.ph",
                                                  "role": "officer"})
    assert code == 201 and body["invite_link"]
    token = body["invite_link"].split("token=")[1]
    anon = Client()
    assert anon.req("get", f"/api/auth/reset-password/validate?token={token}")[0] == 200
    assert anon.req("post", "/api/auth/reset-password", {"token": token, "password": "Benpass123",
                                                         "confirm_password": "Benpass123"})[0] == 200
    assert anon.req("post", "/api/auth/reset-password", {"token": token, "password": "Benpass456",
                                                         "confirm_password": "Benpass456"})[0] == 410  # single use
    assert anon.login("ben@test.ph", "Benpass123")[0] == 200
    # Forgot password never reveals whether an email exists
    a = anon.req("post", "/api/auth/forgot-password", {"email": "nobody@test.ph"})
    b = anon.req("post", "/api/auth/forgot-password", {"email": "ben@test.ph"})
    assert a == b
    # Cannot remove the last admin / deactivate self
    _, me = admin.req("get", "/api/auth/me")
    assert admin.req("post", f"/api/users/{me['user']['id']}/deactivate")[0] == 409


def test_profile_password_and_preferences():
    c = Client()
    c.login("ben@test.ph", "Benpass123")
    assert c.req("patch", "/api/profile", {"first_name": "Benjamin", "contact_number": "0918 765 4321"})[0] == 200
    assert c.req("patch", "/api/profile", {"email": "ben2@test.ph"})[0] == 403  # needs current password
    assert c.req("post", "/api/profile/password", {"current_password": "wrong", "new_password": "Newpass123",
                                                   "confirm_password": "Newpass123"})[0] == 403
    assert c.req("post", "/api/profile/password", {"current_password": "Benpass123", "new_password": "Newpass123",
                                                   "confirm_password": "Newpass123"})[0] == 200
    code, body = c.req("put", "/api/profile/preferences", {"font_size": "large", "export_format": "csv"})
    assert code == 200 and body["preferences"]["font_size"] == "large"


def test_scholar_encoding_validation_and_duplicates():
    c = Client()
    c.login("olive@test.ph", "Officer123")
    code, body = c.req("post", "/api/scholars", scholar_payload(c, mobile_number="123", gender="X"))
    assert code == 422 and "mobile_number" in body["field_errors"] and "gender" in body["field_errors"]
    # Names are not collected: if sent, they are ignored and never stored or returned.
    code, body = c.req("post", "/api/scholars", scholar_payload(c, last_name="Santos", first_name="Juan"))
    assert code == 201, body
    sid = body["scholar"]["code"]
    assert body["scholar"]["code"].startswith("SCH-")
    assert not any(k in body["scholar"] for k in ("last_name", "first_name", "middle_name", "name"))
    _, d = c.req("get", f"/api/scholars/{sid}")
    assert not any(k in d["scholar"] for k in ("last_name", "first_name", "middle_name", "name"))
    # Each saved record gets its own Scholar ID; search works by Scholar ID.
    code2, body2 = c.req("post", "/api/scholars", scholar_payload(c))
    assert code2 == 201 and body2["scholar"]["code"] != sid
    _, lst = c.req("get", f"/api/scholars?q={sid.lower()}")
    assert lst["total"] == 1 and lst["scholars"][0]["code"] == sid
    _, lst = c.req("get", "/api/scholars?q=santos")
    assert lst["total"] == 0
    globals()["SCHOLAR"] = sid


def test_academic_standing_follows_bpmn():
    c = Client()
    c.login("olive@test.ph", "Officer123")
    sid = globals()["SCHOLAR"]
    # 1st year, 2.25 (below 85% / 2.00) -> Probation
    code, body = c.req("post", f"/api/scholars/{sid}/academic-records",
                       {"academic_year": "2024-2025", "semester": "1st Semester", "gwa": 2.25})
    assert code == 201 and body["record"]["standing"] == "Probation", body
    # Same term twice rejected
    assert c.req("post", f"/api/scholars/{sid}/academic-records",
                 {"academic_year": "2024-2025", "semester": "1st Semester", "gwa": 1.5})[0] == 409
    # 3rd-year record with 2.75 -> Good Standing (only passing needed)
    code, body = c.req("post", f"/api/scholars/{sid}/academic-records",
                       {"academic_year": "2024-2025", "semester": "2nd Semester", "gwa": 2.75,
                        "year_level_at_record": 3})
    assert body["record"]["standing"] == "Good Standing"
    # Percentage scale: 80% for 1st year -> Probation; 3.50 -> Failed
    code, body = c.req("post", f"/api/scholars/{sid}/academic-records",
                       {"academic_year": "2025-2026", "semester": "1st Semester", "gwa": 80})
    assert body["record"]["standing"] == "Probation" and body["record"]["gwa_scale"] == "percent"
    code, body = c.req("post", f"/api/scholars/{sid}/academic-records",
                       {"academic_year": "2025-2026", "semester": "2nd Semester", "gwa": 3.5})
    assert body["record"]["standing"] == "Failed"
    assert body["scholar"]["below_requirement_two_semesters"] is True
    assert body["scholar"]["eligible_for_termination_recommendation"] is True


def test_stipend_graduation_and_termination_workflow():
    off = Client()
    off.login("olive@test.ph", "Officer123")
    adm = Client()
    adm.login("admin@test.ph", "Admin1234")
    sid = globals()["SCHOLAR"]
    assert off.req("post", f"/api/scholars/{sid}/stipends", {"period": "1st Semester 2024-2025", "amount": 20000,
                                                            "status": "Released"})[0] == 422  # needs date
    code, body = off.req("post", f"/api/scholars/{sid}/stipends", {"period": "1st Semester 2024-2025",
                                                                  "amount": 20000, "status": "Released",
                                                                  "date_released": "2024-09-10"})
    assert code == 201 and body["scholar"]["stipends_released"] == 1
    assert off.req("put", f"/api/scholars/{sid}/graduation", {"status": "On Track",
                                                             "expected_graduation": "2028-06"})[0] == 200
    # Admin cannot file a recommendation; officer can
    eff = (date.today() + timedelta(days=30)).isoformat()
    payload = {"grounds": "Academic failure — below minimum GWA for 2nd consecutive semester",
               "notes": "Counseling done twice; GWA kept dropping over two semesters.",
               "proposed_effective_date": eff}
    assert adm.req("post", f"/api/scholars/{sid}/termination-requests", payload)[0] == 403
    code, body = off.req("post", f"/api/scholars/{sid}/termination-requests", payload)
    assert code == 201 and body["scholar"]["status"] == "pending_termination"
    req_id = body["scholar"]["termination"]["pending"]["id"]
    assert off.req("post", f"/api/termination-requests/{req_id}/approve", {})[0] == 403
    assert adm.req("post", f"/api/termination-requests/{req_id}/return", {"remarks": "short"})[0] == 422
    code, body = adm.req("post", f"/api/termination-requests/{req_id}/return",
                         {"remarks": "Attach the counseling dates and HEI report."})
    assert body["scholar"]["status"] == "active"
    _, dash = off.req("get", "/api/dashboard")
    assert any("returned" in t["title"] for t in dash["tasks"])
    code, body = off.req("post", f"/api/scholars/{sid}/termination-requests", payload)
    req_id = body["scholar"]["termination"]["pending"]["id"]
    code, body = adm.req("post", f"/api/termination-requests/{req_id}/approve", {})
    assert body["scholar"]["status"] == "terminated"
    # Locked after termination
    assert off.req("post", f"/api/scholars/{sid}/stipends", {"period": "x", "amount": 1, "status": "Pending"})[0] == 409
    # Deactivate / restore (admin only)
    assert off.req("post", f"/api/scholars/{sid}/deactivate")[0] == 403
    assert adm.req("post", f"/api/scholars/{sid}/deactivate")[0] == 200
    assert off.req("get", f"/api/scholars/{sid}")[0] == 404
    assert adm.req("post", f"/api/scholars/{sid}/restore")[0] == 200


def test_spreadsheet_import_preview_and_atomic_commit():
    c = Client()
    c.login("olive@test.ph", "Officer123")
    csv_text = (
        "Gender,Date of Birth,Mobile Number,Email,Scholarship Program,"
        "Scholarship Cycle,Municipality,Secondary School,Enrollment Date,HEI,Degree Program,Year Level\n"
        "Female,2006-01-02,09181112222,,RA 7687,2024-2025,Mati City,Mati National High School,"
        "2024-08-12,DOSCST — Main Campus,BS Biology,1st Year\n"
        "M,03/04/2005,0919 333 4444,,Merit,2023-2024,City of Mati,Mati National High School,"
        "2023-08-10,DOSCST — Main Campus,BS Math,2\n"
        "X,notadate,123,,Unknown,1999,Nowhere,Nope,2030-01-01,Nope,,9\n"
        ",,,,,,,,,,,\n")
    r = c.c.post("/api/scholars/import/preview", headers={"X-CSRF-Token": c.csrf},
                 data={"file": (io.BytesIO(csv_text.encode()), "batch.csv")}, content_type="multipart/form-data")
    body = r.get_json()
    assert r.status_code == 200, body
    assert body["total_rows"] == 3 and body["valid_rows"] == 2 and body["error_rows"] == 1
    assert all("name" not in p for p in body["preview"])
    code, res = c.req("post", f"/api/scholars/import/{body['batch_id']}/commit")
    assert code == 200 and res["created"] == 2
    assert c.req("post", f"/api/scholars/import/{body['batch_id']}/commit")[0] == 409
    # Wrong file type
    r = c.c.post("/api/scholars/import/preview", headers={"X-CSRF-Token": c.csrf},
                 data={"file": (io.BytesIO(b"x"), "evil.exe")}, content_type="multipart/form-data")
    assert r.status_code == 422
    assert c.c.get("/api/scholars/import/template.xlsx").status_code == 200


def test_dashboard_notifications_geomap_audit():
    adm = Client()
    adm.login("admin@test.ph", "Admin1234")
    code, dash = adm.req("get", "/api/dashboard")
    assert code == 200 and dash["role"] == "admin" and len(dash["municipalities"]) == 11
    _, notes = adm.req("get", "/api/notifications")
    assert notes["unread"] > 0
    assert adm.req("post", "/api/notifications/read-all")[0] == 200
    assert adm.req("get", "/api/notifications")[1]["unread"] == 0
    _, geo = adm.req("get", "/api/geomap")
    assert geo["totals"]["total"] >= 3
    _, logs = adm.req("get", "/api/audit-logs?category=security&q=locked")
    assert logs["total"] >= 1
    assert adm.c.get("/api/audit-logs/export").status_code == 200
    _, v = adm.req("get", "/api/audit-logs/verify")
    assert v["intact"] is True
    # Tampering is detected
    tamper = "UPDATE audit_logs SET action = 'edited by attacker' WHERE id = (SELECT m FROM (SELECT MIN(id) AS m FROM audit_logs) x)"
    if H.DB_URL.startswith("mysql"):
        # On MySQL the database itself refuses edits to the audit log...
        try:
            H.sql(tamper)
            raise AssertionError("audit log edit should have been refused")
        except Exception as err:   # noqa: BLE001
            assert "append-only" in str(err)
        # ...and if someone with server access removes that protection, verification still catches it.
        H.sql("DROP TRIGGER audit_logs_no_update")
    H.sql(tamper)
    _, v = adm.req("get", "/api/audit-logs/verify")
    assert v["intact"] is False


def test_session_idle_timeout():
    c = Client()
    c.login("olive@test.ph", "Officer123")
    old = (datetime.now(timezone.utc) - timedelta(minutes=31)).strftime("%Y-%m-%d %H:%M:%S")
    H.sql("UPDATE user_sessions SET last_seen_at = ? WHERE revoked_at IS NULL", (old,))
    code, body = c.req("get", "/api/auth/me")
    assert code == 401 and body["code"] == "session_expired"


def test_corrections_reference_lists_and_reinstatement():
    off = Client(); off.login("olive@test.ph", "Officer123")
    adm = Client(); adm.login("admin@test.ph", "Admin1234")
    code, body = off.req("post", "/api/scholars", scholar_payload(off, last_name="Lopez", first_name="Mara",
                                                                 birth_date="2006-07-07"))
    sid = body["scholar"]["code"]
    _, body = off.req("post", f"/api/scholars/{sid}/academic-records",
                      {"academic_year": "2024-2025", "semester": "1st Semester", "gwa": 3.75})
    rec = body["record"]["id"]
    assert body["scholar"]["academic_standing"] == "Failed"
    # Officer cannot correct; admin must give a reason
    assert off.req("patch", f"/api/scholars/{sid}/academic-records/{rec}", {"gwa": 1.75, "reason": "typo"})[0] == 403
    assert adm.req("patch", f"/api/scholars/{sid}/academic-records/{rec}", {"gwa": 1.75})[0] == 422
    code, body = adm.req("patch", f"/api/scholars/{sid}/academic-records/{rec}",
                         {"gwa": 1.75, "reason": "Typo: 3.75 should be 1.75"})
    assert code == 200 and body["scholar"]["academic_standing"] == "Good Standing"
    code, body = adm.req("delete", f"/api/scholars/{sid}/academic-records/{rec}", {"reason": "Encoded twice"})
    assert code == 200 and body["scholar"]["academic_standing"] is None
    # Stipend delete is admin only
    _, body = off.req("post", f"/api/scholars/{sid}/stipends", {"period": "1st Sem 2024-2025", "amount": 1000,
                                                               "status": "Pending"})
    st = body["stipend"]["id"]
    assert off.req("delete", f"/api/scholars/{sid}/stipends/{st}", {"reason": "mistake"})[0] == 403
    assert adm.req("delete", f"/api/scholars/{sid}/stipends/{st}", {"reason": "Saved by mistake"})[0] == 200

    # Withdraw a pending recommendation
    off.req("post", f"/api/scholars/{sid}/academic-records",
            {"academic_year": "2024-2025", "semester": "2nd Semester", "gwa": 3.5})
    eff = (date.today() + timedelta(days=10)).isoformat()
    rec_payload = {"grounds": "Failure to enroll on time", "notes": "Did not enroll for the semester despite two reminders.",
                   "proposed_effective_date": eff}
    _, body = off.req("post", f"/api/scholars/{sid}/termination-requests", rec_payload)
    rid = body["scholar"]["termination"]["pending"]["id"]
    assert adm.req("post", f"/api/termination-requests/{rid}/withdraw", {"reason": "x"})[0] == 403
    code, body = off.req("post", f"/api/termination-requests/{rid}/withdraw", {"reason": "Filed for the wrong scholar"})
    assert code == 200 and body["scholar"]["status"] == "active"
    # Approve, then reinstate
    _, body = off.req("post", f"/api/scholars/{sid}/termination-requests", rec_payload)
    rid = body["scholar"]["termination"]["pending"]["id"]
    adm.req("post", f"/api/termination-requests/{rid}/approve", {})
    assert off.req("post", f"/api/scholars/{sid}/reinstate", {"remarks": "Appeal approved"})[0] == 403
    code, body = adm.req("post", f"/api/scholars/{sid}/reinstate", {"remarks": "Appeal approved by the Regional Director"})
    assert code == 200 and body["scholar"]["status"] == "active"
    assert body["scholar"]["termination"]["reversed"]["reversal_remarks"].startswith("Appeal")

    # Reference lists
    assert off.req("get", "/api/admin/reference")[0] == 403
    _, ref = adm.req("get", "/api/admin/reference")
    muni = ref["municipalities"][0]["id"]
    code, body = adm.req("post", "/api/admin/reference/schools", {"name": "Test Science High School", "municipality_id": muni})
    assert code == 201
    new_school = body["id"]
    assert adm.req("post", "/api/admin/reference/schools", {"name": "Test Science High School", "municipality_id": muni})[0] == 409
    assert adm.req("post", "/api/admin/reference/cycles", {"start_year": 2031})[0] == 201
    used_hei = next(h for h in ref["heis"] if h["scholars"] > 0)
    assert adm.req("patch", f"/api/admin/reference/heis/{used_hei['id']}", {"is_active": False})[0] == 200
    _, lk = off.req("get", "/api/lookups")
    assert used_hei["id"] not in [h["id"] for h in lk["heis"]]
    assert any(s["id"] == new_school for s in lk["schools"])
    assert any(c["label"] == "2031-2032" for c in lk["cycles"])
    # A scholar already using the deactivated HEI can still be edited
    _, sch = off.req("get", f"/api/scholars?per_page=100")
    user_of_hei = next(x for x in sch["scholars"] if x["hei"] == used_hei["name"])
    _, detail = off.req("get", f"/api/scholars/{user_of_hei['code']}")
    d = detail["scholar"]
    assert off.req("patch", f"/api/scholars/{d['code']}", {"hei": d["hei_id"], "degree_program": "BS Chemistry"})[0] == 200
    # ...but a new record cannot use it
    code, body = off.req("post", "/api/scholars", scholar_payload(off, last_name="Neri", first_name="Ivy",
                                                                 birth_date="2006-01-09", hei=used_hei["id"]))
    assert code == 422 and "hei" in body["field_errors"]
    adm.req("patch", f"/api/admin/reference/heis/{used_hei['id']}", {"is_active": True})

    # Preferences: theme + digest preview
    assert off.req("put", "/api/profile/preferences", {"theme": "dark"})[1]["preferences"]["theme"] == "dark"
    assert off.req("put", "/api/profile/preferences", {"theme": "neon"})[0] == 422
    code, body = off.req("post", "/api/profile/digest-preview")
    assert code == 200 and body["mail_configured"] is False


def test_cycles_are_created_automatically():
    script = ("const db=require('./src/db'); const V=require('./src/lib/validators');"
              "(async()=>{ await V.ensureCycles(db(), new Date(2040,6,1)); await V.ensureCycles(db(), new Date(2045,2,1));"
              "const l=(await db()('scholarship_cycles').select('label')).map(r=>r.label); console.log(JSON.stringify(l)); await db.reset(); })()")
    import json, subprocess
    out = subprocess.run(["node", "-e", script], cwd=H.SERVER_DIR, env=H.env(), capture_output=True, text=True, check=True).stdout
    labels = set(json.loads(out))
    assert {"2040-2041", "2041-2042"} <= labels
    assert "2044-2045" in labels   # before June -> still the 2044-2045 school year

def _upload(client, url, filename, content, **form):
    data = {"file": (io.BytesIO(content), filename), **form}
    r = client.c.post(url, headers={"X-CSRF-Token": client.csrf}, data=data, content_type="multipart/form-data")
    return r.status_code, r.get_json()


def test_bulk_gwa_and_stipend_import():
    off = Client(); off.login("olive@test.ph", "Officer123")
    _, lst = off.req("get", "/api/scholars?status=active&per_page=100")
    a, b = lst["scholars"][0]["code"], lst["scholars"][1]["code"]
    csv_text = ("Scholar ID,Academic Year,Semester,GWA,Year Level,Date Recorded\n"
                f"{a},2023-2024,1st Semester,1.75,1st Year,2024-01-15\n"
                f"{b},2023-2024,1st sem,2.50,,\n"
                f"{b},2023-2024,1st Semester,2.10,,\n"          # duplicate term in file
                "SCH-1999-999,2023-2024,2nd Semester,1.5,,\n"   # unknown scholar
                f"{a},2023-2024,Third,6.5,,2099-01-01\n")        # bad semester, GWA, date
    code, body = _upload(off, "/api/records-import/academic/preview", "gwa.csv", csv_text.encode())
    assert code == 200, body
    assert body["valid_rows"] == 2 and body["error_rows"] == 3
    assert body["preview"][1]["standing"] == "Probation"
    code, res = off.req("post", f"/api/records-import/{body['batch_id']}/commit")
    assert code == 200 and res["created"] == 2
    # same file again: now duplicates against the database
    code, body = _upload(off, "/api/records-import/academic/preview", "gwa.csv", csv_text.encode())
    assert body["valid_rows"] == 0 and any("already has" in e["message"] for e in body["errors"])
    st = ("Scholar ID,Disbursement Period,Amount,Status,Date Released,Remarks\n"
          f"{a},Bulk Period 1,\"20,000\",Released,2024-02-01,\n"
          f"{b},Bulk Period 1,15000,Inconsistent,,\n"   # missing remarks
          f"{b},Bulk Period 1,15000,Pending,,\n")
    code, body = _upload(off, "/api/records-import/stipends/preview", "stipends.csv", st.encode())
    assert body["valid_rows"] == 2 and body["error_rows"] == 1
    assert off.req("post", f"/api/records-import/{body['batch_id']}/commit")[1]["created"] == 2
    assert off.c.get("/api/records-import/academic/template.xlsx").status_code == 200
    # a scholar-import batch id can't be committed through the records endpoint and vice versa
    assert off.req("post", f"/api/scholars/import/{body['batch_id']}/commit")[0] == 404


def test_documents_pdf_record_and_data_export():
    off = Client(); off.login("olive@test.ph", "Officer123")
    adm = Client(); adm.login("admin@test.ph", "Admin1234")
    _, lst = off.req("get", "/api/scholars?status=active&per_page=5")
    code_ = lst["scholars"][0]["code"]
    url = f"/api/scholars/{code_}/documents"
    assert _upload(off, url, "report.pdf", b"%PDF-1.4 test", doc_type="Grade report")[0] == 201
    assert _upload(off, url, "evil.pdf", b"MZ\x90\x00 not a pdf", doc_type="Grade report")[0] == 422
    assert _upload(off, url, "notes.exe", b"MZ", doc_type="Other")[0] == 422
    assert _upload(off, url, "report.pdf", b"%PDF-1.4", doc_type="Nonsense")[0] == 422
    _, docs = off.req("get", url)
    doc_id = docs["documents"][0]["id"]
    r = off.c.get(f"{url}/{doc_id}")
    assert r.status_code == 200 and r.data.startswith(b"%PDF")
    assert off.req("delete", f"{url}/{doc_id}", {"reason": "wrong file"})[0] == 403
    assert adm.req("delete", f"{url}/{doc_id}", {"reason": "Uploaded for the wrong scholar"})[0] == 200
    assert off.req("get", url)[1]["documents"] == []
    r = off.c.get(f"/api/scholars/{code_}/record.pdf")
    assert r.status_code == 200 and r.mimetype == "application/pdf" and r.data.startswith(b"%PDF")
    assert off.c.get(f"/api/scholars/{code_}/data-export").status_code == 403
    r = adm.c.get(f"/api/scholars/{code_}/data-export")
    exported = r.get_json() if r.is_json else __import__("json").loads(r.data)
    assert exported["scholar"]["code"] == code_ and exported["who_accessed_or_changed_this_record"]


def test_retention_review_is_view_only():
    """Anonymization is not part of the system design: the endpoint must not exist,
    and the retention review only lists records."""
    off = Client(); off.login("olive@test.ph", "Officer123")
    adm = Client(); adm.login("admin@test.ph", "Admin1234")
    _, body = off.req("post", "/api/scholars", scholar_payload(off, birth_date="2005-02-02"))
    sid = body["scholar"]["code"]
    off.req("put", f"/api/scholars/{sid}/graduation", {"status": "Graduated", "actual_graduation": "2025-06-01",
                                                       "expected_graduation": "2025-06"})
    code, _ = adm.req("post", f"/api/scholars/{sid}/anonymize", {"password": "Admin1234", "reason": "Retention ended"})
    assert code in (404, 405)
    _, d = adm.req("get", f"/api/scholars/{sid}")
    assert d["scholar"]["code"] == sid
    assert off.req("get", "/api/admin/privacy/retention")[0] == 403
    code, ret = adm.req("get", "/api/admin/privacy/retention")
    assert code == 200 and "retention_years" in ret and "due" in ret and "upcoming" in ret
    assert any(r["code"] == sid for r in ret["upcoming"] + ret["due"])

def test_sessions_monitoring_and_remote_signout():
    off = Client(); off.login("olive@test.ph", "Officer123")
    adm = Client(); adm.login("admin@test.ph", "Admin1234")
    assert off.req("get", "/api/admin/sessions")[0] == 403
    _, data = adm.req("get", "/api/admin/sessions")
    mine = [x for x in data["sessions"] if x["is_current"]]
    olive = [x for x in data["sessions"] if x["username"] == "olive"]
    assert len(mine) == 1 and olive
    assert adm.req("post", f"/api/admin/sessions/{mine[0]['id']}/revoke")[0] == 409
    for x in olive:
        adm.req("post", f"/api/admin/sessions/{x['id']}/revoke")
    assert off.req("get", "/api/auth/me")[0] == 401


def test_backup_and_restore():
    adm = Client(); adm.login("admin@test.ph", "Admin1234")
    off = Client(); off.login("olive@test.ph", "Officer123")
    _, before = adm.req("get", "/api/scholars?per_page=5")
    code, body = adm.req("post", "/api/admin/backups", {"note": "test"})
    assert code == 201
    name = body["backup"]["name"]
    assert adm.req("post", f"/api/admin/backups/{name}/verify")[0] == 200
    # change data after the backup
    off.req("post", "/api/scholars", scholar_payload(off, last_name="Added", first_name="After", birth_date="2006-09-09"))
    assert adm.req("get", "/api/scholars?per_page=5")[1]["stats"]["total"] == before["stats"]["total"] + 1
    assert adm.req("post", f"/api/admin/backups/{name}/restore", {"confirm": "nope", "password": "Admin1234"})[0] == 422
    assert adm.req("post", f"/api/admin/backups/{name}/restore", {"confirm": "RESTORE", "password": "bad"})[0] == 403
    code, res = adm.req("post", f"/api/admin/backups/{name}/restore", {"confirm": "RESTORE", "password": "Admin1234"})
    assert code == 200 and res["signed_out"] and res["safety_backup"]
    assert adm.req("get", "/api/auth/me")[0] == 401            # everyone signs in again
    adm2 = Client(); adm2.login("admin@test.ph", "Admin1234")
    assert adm2.req("get", "/api/scholars?per_page=5")[1]["stats"]["total"] == before["stats"]["total"]
    assert adm2.req("get", "/api/audit-logs/verify")[1]["checked"] > 0
    _, lst = adm2.req("get", "/api/admin/backups")
    assert any(b["kind"] == "pre-restore" for b in lst["backups"])
    r = adm2.c.get(f"/api/admin/backups/{name}/download")
    assert r.status_code == 200
    # a file made with another key is refused
    code, body = _upload(adm2, "/api/admin/backups/upload", "x.iskb", b"gAAAAAnotvalid")
    assert code == 422
    code, body = _upload(adm2, "/api/admin/backups/upload", "copy.iskb", r.data)
    assert code == 201


def test_rate_limit_per_address():
    global BASE
    saved = BASE
    BASE = H.start_server(RATE_LIMIT_FAILED_LOGINS=3)   # same database, stricter limit
    try:
        c = Client()
        for i in range(3):
            assert c.login(f"nobody{i}@test.ph", "x")[0] == 401
        assert c.login("admin@test.ph", "Admin1234")[0] == 429
    finally:
        BASE = saved

if __name__ == "__main__":
    setup_module()
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    order = ["test_auth_signup_approval_lockout_and_rbac", "test_admin_creates_user_with_invite_and_reset_flow",
             "test_profile_password_and_preferences", "test_scholar_encoding_validation_and_duplicates",
             "test_academic_standing_follows_bpmn", "test_stipend_graduation_and_termination_workflow",
             "test_spreadsheet_import_preview_and_atomic_commit", "test_corrections_reference_lists_and_reinstatement",
             "test_cycles_are_created_automatically", "test_dashboard_notifications_geomap_audit",
             "test_session_idle_timeout"]
    for name in order:
        globals()[name]()
        print("PASS", name)
