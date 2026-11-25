import json
import urllib.request
import urllib.error
import time

def request(url, method="GET", data=None, headers=None):
    if headers is None:
        headers = {}
    if data is not None:
        if isinstance(data, dict):
            data = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(body)
            except Exception:
                return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body
    except Exception as e:
        return 500, str(e)

def run_smoke_tests():
    results = {}
    print("==================================================")
    print("STARTING FULL-STACK DOCKER COMPOSE RUNTIME SMOKE")
    print("==================================================")

    # 1. AI Service Direct Check
    print("\n--- 1. AI SERVICE DIRECT ENDPOINTS ---")
    st, ai_chk = request("http://localhost:8000/api/v1/writing/sentence-check", method="POST", data={"text": "She don't understand the assignment."})
    print(f"AI sentence-check status: {st}")
    ai_direct_pass = (st == 200 and ai_chk.get("grammatically_correct") is False)
    print(f"AI sentence-check correct=false: {ai_direct_pass}")
    results["ai_direct"] = ai_direct_pass

    # 2. Backend Writing Capabilities
    print("\n--- 2. BACKEND WRITING CAPABILITIES ---")
    st, cap = request("http://localhost:8080/api/v1/writing/capabilities")
    print(f"Backend capabilities status: {st}")
    backend_cap_pass = (st == 200 and cap.get("enabled") is True)
    print(f"Backend capabilities enabled=true: {backend_cap_pass} (mutations={cap.get('mutationsEnabled')}, assessments={cap.get('assessmentsEnabled')}, worker={cap.get('workerEnabled')})")
    results["backend_capabilities"] = backend_cap_pass

    # 3. Sentence Check (Section 13.A: She don't understand the assignment)
    print("\n--- 3. FULL STACK SENTENCE CHECK (A: Incorrect sentence) ---")
    st, chk_a = request("http://localhost:8080/api/v1/writing/sentence-checks", method="POST", data={
        "text": "She don't understand the assignment.",
        "targetRegister": "formal"
    })
    print(f"Sentence check A status: {st}")
    check_a_pass = False
    if st in (200, 201):
        gc = chk_a.get("grammaticallyCorrect")
        issues = chk_a.get("issues", [])
        print(f"grammaticallyCorrect: {gc} (expected False)")
        print(f"Found {len(issues)} issues")
        for iss in issues:
            print(f"  - Category: {iss.get('category')}, Pattern: {iss.get('patternCode')}, Repl: {iss.get('replacement')}")
        check_a_pass = (gc is False and len(issues) > 0 and any(i.get("category") == "Grammar" for i in issues))
    print(f"Sentence check A PASS: {check_a_pass}")
    results["sentence_check_incorrect"] = check_a_pass

    # 4. Correct Sentence (Section 13.B: The committee approved the budget yesterday)
    print("\n--- 4. FULL STACK SENTENCE CHECK (B: Correct sentence) ---")
    st, chk_b = request("http://localhost:8080/api/v1/writing/sentence-checks", method="POST", data={
        "text": "The committee approved the budget yesterday.",
        "targetRegister": "formal"
    })
    print(f"Sentence check B status: {st}")
    check_b_pass = False
    if st in (200, 201):
        gc = chk_b.get("grammaticallyCorrect")
        print(f"grammaticallyCorrect: {gc} (expected True)")
        check_b_pass = (gc is True)
    print(f"Sentence check B PASS: {check_b_pass}")
    results["sentence_check_correct"] = check_b_pass

    # 5. Inconclusive Semantics (Section 13.C: grammaticallyCorrect = null)
    print("\n--- 5. FULL STACK SENTENCE CHECK (C: Inconclusive fragment) ---")
    st, chk_c = request("http://localhost:8080/api/v1/writing/sentence-checks", method="POST", data={
        "text": "Although having many ideas",
        "targetRegister": "formal"
    })
    print(f"Sentence check C status: {st}")
    check_c_pass = False
    if st in (200, 201):
        gc = chk_c.get("grammaticallyCorrect")
        print(f"grammaticallyCorrect: {gc} (expected None/null for fragment/inconclusive)")
        check_c_pass = (gc is None)
    print(f"Sentence check C PASS: {check_c_pass}")
    results["sentence_check_inconclusive"] = check_c_pass

    # 6. Writing Session Lifecycle (Section 13.D: create -> edit -> autosave -> submit -> assessment)
    print("\n--- 6. WRITING SESSION LIFECYCLE ---")
    st_t, tasks = request("http://localhost:8080/api/v1/writing/tasks")
    task_id = "TASK-OPINION-TECH"
    if st_t == 200 and isinstance(tasks, list) and len(tasks) > 0:
        task_id = tasks[0].get("id", task_id)
    print(f"Using taskId: {task_id}")

    st, sess = request("http://localhost:8080/api/v1/writing/sessions", method="POST", data={
        "taskId": task_id,
        "title": "Docker Smoke Essay",
        "mode": "ESSAY",
        "targetWordCount": 150
    })
    print(f"Create session status: {st}")
    session_flow_pass = False
    if st in (200, 201):
        session_id = sess.get("id")
        revision = sess.get("revision", 1)
        print(f"Created session ID: {session_id}, revision: {revision}")

        import uuid
        mut_id = f"smoke-mut-{uuid.uuid4()}"
        sub_id = f"smoke-sub-{uuid.uuid4()}"

        # Autosave / edit working copy
        st_patch, updated = request(f"http://localhost:8080/api/v1/writing/sessions/{session_id}/working-copy", method="PATCH", data={
            "workingText": "Technology plays an important role in modern education. However, it can also create distractions if students don't manage their time properly.",
            "workingPlan": "1. Introduction\n2. Benefits\n3. Challenges\n4. Conclusion",
            "expectedRevision": revision,
            "clientMutationId": mut_id
        })
        print(f"Update working copy status: {st_patch}")
        new_rev = updated.get("revision", revision + 1) if isinstance(updated, dict) else revision + 1

        # Submit draft
        st_sub, draft_res = request(f"http://localhost:8080/api/v1/writing/sessions/{session_id}/drafts", method="POST", data={
            "expectedRevision": new_rev,
            "clientMutationId": sub_id
        })
        print(f"Submit draft status: {st_sub}")
        if isinstance(draft_res, dict):
            print(f"Draft assessment score: {draft_res.get('overallBandScore')}, issues: {len(draft_res.get('feedbackIssues', []))}")
        session_flow_pass = (st_patch in (200, 204) and st_sub in (200, 201))
    print(f"Writing session lifecycle PASS: {session_flow_pass}")
    results["session_lifecycle"] = session_flow_pass

    # 7. Error Memory (Section 13.E: My Mistakes)
    print("\n--- 7. ERROR MEMORY / MY MISTAKES ---")
    st, mistakes = request("http://localhost:8080/api/v1/writing/mistakes")
    print(f"Get mistakes status: {st}")
    mistakes_pass = (st == 200 and isinstance(mistakes, list))
    print(f"Mistakes list returned: {mistakes_pass}, count={len(mistakes) if isinstance(mistakes, list) else 0}")
    results["error_memory"] = mistakes_pass

    # 8. Portfolio & For You (Section 13.F)
    print("\n--- 8. PORTFOLIO & FOR-YOU ---")
    st_port, port = request("http://localhost:8080/api/v1/writing/portfolio")
    st_foryou, foryou = request("http://localhost:8080/api/v1/writing/for-you")
    print(f"Portfolio status: {st_port}, For-You status: {st_foryou}")
    port_pass = (st_port == 200 and st_foryou == 200)
    print(f"Portfolio & For You PASS: {port_pass}")
    results["portfolio_and_for_you"] = port_pass

    # 9. P1 Runtime Smoke (Section 14)
    print("\n--- 9. P1 RUNTIME SMOKE: SOURCES, ANALYTICS, INTELLIGENCE ---")
    st_src, src_avail = request("http://localhost:8080/api/v1/writing/sources/available")
    print(f"Available sources status: {st_src}, items: {len(src_avail) if isinstance(src_avail, list) else 0}")

    source_handoff_pass = False
    if st_src == 200 and isinstance(src_avail, list) and len(src_avail) > 0:
        src = src_avail[0]
        st_hnd, sess_from_src = request("http://localhost:8080/api/v1/writing/sources/create-session", method="POST", data={
            "sourceType": src.get("sourceType"),
            "sourceId": src.get("sourceId")
        })
        print(f"Create session from source status: {st_hnd}, session ID: {sess_from_src.get('id') if isinstance(sess_from_src, dict) else None}")
        source_handoff_pass = (st_hnd in (200, 201))
    else:
        st_hnd, sess_from_src = request("http://localhost:8080/api/v1/writing/sources/create-session", method="POST", data={
            "sourceType": "FLASHCARD"
        })
        print(f"Create session from default FLASHCARD status: {st_hnd}")
        source_handoff_pass = (st_hnd in (200, 201))

    st_rep, report = request("http://localhost:8080/api/v1/writing/analytics/weekly-report")
    print(f"Weekly report status: {st_rep}")

    st_long, long_prog = request("http://localhost:8080/api/v1/writing/analytics/longitudinal")
    print(f"Longitudinal analytics status: {st_long}")

    st_skills, skills_res = request("http://localhost:8080/api/v1/writing/analytics/skills")
    print(f"Skill masteries status: {st_skills}")

    st_soc, socratic = request("http://localhost:8080/api/v1/writing/intelligence/socratic-plan", method="POST", data={
        "topic": "The advantages of remote work",
        "currentIdeas": ["Flexibility", "No commute"],
        "targetRegister": "academic"
    })
    print(f"Socratic planning status: {st_soc}")

    st_task, task_gen = request("http://localhost:8080/api/v1/writing/intelligence/task-generate", method="POST", data={
        "targetLevel": "B2",
        "category": "ARGUMENTATIVE"
    })
    print(f"Adaptive task generation status: {st_task}")

    st_comp, model_comp = request("http://localhost:8080/api/v1/writing/intelligence/compare-model", method="POST", data={
        "taskPrompt": "The advantages of remote work",
        "learnerDraft": "Working from home provides flexibility and reduces daily commuting stress.",
        "targetRegister": "formal",
        "learnerLevel": "B2"
    })
    print(f"Model comparison status: {st_comp}")

    p1_pass = (source_handoff_pass and st_rep == 200 and st_long == 200 and st_skills == 200 and st_soc == 200 and st_task == 200 and st_comp == 200)
    print(f"P1 Runtime Smoke PASS: {p1_pass}")
    results["p1_runtime"] = p1_pass

    # 10. Frontend Stale Image Check & Legacy Modules (Section 16 & 17)
    print("\n--- 10. FRONTEND CONTENT & ROUTE VERIFICATION ---")
    st_fe, fe_html = request("http://localhost:3000/writing")
    print(f"Frontend /writing status: {st_fe}")

    st_tab, fe_tab_html = request("http://localhost:3000/?tab=writing")
    print(f"Frontend /?tab=writing status: {st_tab}")

    no_coming_soon = ("Writing module coming soon" not in str(fe_html)) and ("Writing module coming soon" not in str(fe_tab_html))
    has_writing_nav = "Writing" in str(fe_html) or "writing" in str(fe_html)
    print(f"Old placeholder absent: {no_coming_soon}, Writing reference present: {has_writing_nav}")

    st_home, _ = request("http://localhost:3000/")
    st_flash, _ = request("http://localhost:3000/?tab=flashcards")
    st_read, _ = request("http://localhost:3000/?tab=reading")
    st_speak, _ = request("http://localhost:3000/speaking")
    st_listen, _ = request("http://localhost:3000/listening")
    st_exam, _ = request("http://localhost:3000/?tab=exams")
    print(f"Legacy modules status -> Home: {st_home}, Flashcards: {st_flash}, Reading: {st_read}, Listening: {st_listen}, Speaking: {st_speak}, Exams: {st_exam}")
    fe_pass = (st_fe == 200 and st_tab == 200 and no_coming_soon and st_home == 200 and st_flash == 200 and st_read == 200 and st_speak == 200 and st_listen == 200 and st_exam == 200)
    print(f"Frontend & Legacy Modules PASS: {fe_pass}")
    results["frontend_and_legacy"] = fe_pass

    print("\n==================================================")
    print("FINAL SUMMARY OF SMOKE TEST RESULTS")
    print("==================================================")
    for k, v in results.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
    all_pass = all(results.values())
    print(f"\nOVERALL RESULT: {'ALL PASS' if all_pass else 'SOME FAILED'}")
    return all_pass

if __name__ == "__main__":
    run_smoke_tests()
