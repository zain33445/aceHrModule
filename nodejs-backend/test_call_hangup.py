"""
Browser test: whoever hangs up, the call ends on BOTH screens.

Regression test for the bug where the receiver ended an answered call and the
caller's window stayed open showing "Connecting to <name>…".

  1. The admin (manan) calls the employee (daood); the employee accepts.
  2. Both sides reach the live call (the timer is running).
  3. The RECEIVER hangs up.
  4. Both call windows must close.
  5. The same again with the CALLER hanging up.

Run with:
    C:\\Users\\Lenovo\\.agents\\skills\\seo\\.venv\\Scripts\\python.exe test_call_hangup.py

Requires: backend on :5000, vite dev server (npm run dev:lan) on :5173.
"""

import re
import sys

from playwright.sync_api import sync_playwright

from test_call_browser import APP, CALLEE, CHROMIUM_PATH, HOST, login, open_calls_tab, preflight

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}{f' — {detail}' if detail else ''}")


def call_window_open(page):
    return page.get_by_role("button", name="End call").count() > 0


def wait_closed(page, timeout_ms=8000):
    """True once the call window is gone (polls; the page may be in the background)."""
    waited = 0
    while waited < timeout_ms:
        if not call_window_open(page):
            return True
        page.wait_for_timeout(250)
        waited += 250
    return False


def wait_live(page, timeout_ms=30000):
    """True once the header shows the running call timer (m:ss)."""
    timer = page.get_by_text(re.compile(r"^\d+:\d\d$"))
    waited = 0
    while waited < timeout_ms:
        if timer.count() > 0:
            return True
        page.wait_for_timeout(500)
        waited += 500
    return False


def place_call(host, callee):
    host.get_by_placeholder("Search people…").fill("Daood")
    host.wait_for_timeout(400)
    host.get_by_role("button", name=re.compile("Daood")).first.click()
    host.get_by_role("button", name="Start call").click()
    callee.wait_for_selector("text=Incoming call", timeout=20000)
    callee.get_by_role("button", name="Accept call").click()


def run_round(label, host, callee, who_hangs_up):
    print(f"\n{label}")
    place_call(host, callee)
    check("the caller reaches the live call", wait_live(host))
    check("the receiver reaches the live call", wait_live(callee))

    quitter, other = (callee, host) if who_hangs_up == "receiver" else (host, callee)
    quitter.get_by_role("button", name="End call").click()

    check(f"the {who_hangs_up}'s call window closes", wait_closed(quitter))
    other_closed = wait_closed(other)
    stuck = other.get_by_text(re.compile("Connecting to")).count() > 0
    check(
        "the other side's call window closes too",
        other_closed,
        "still open" + (" and showing 'Connecting to …'" if stuck else ""),
    )
    # Clean up a stuck window so the next round starts from idle.
    if not other_closed:
        other.get_by_role("button", name="End call").click()
        wait_closed(other)
    host.wait_for_timeout(1500)


def main():
    print("\naceHRM — hang-up test\n")
    preflight()

    with sync_playwright() as p:
        launch_args = {
            "args": [
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
            ]
        }
        if CHROMIUM_PATH:
            launch_args["executable_path"] = CHROMIUM_PATH
        browser = p.chromium.launch(**launch_args)

        def new_page():
            ctx = browser.new_context(
                viewport={"width": 1280, "height": 900},
                permissions=["camera", "microphone"],
                ignore_https_errors=True,
            )
            ctx.grant_permissions(["camera", "microphone"], origin=APP)
            return ctx.new_page()

        host, callee = new_page(), new_page()
        errors = []
        host.on("pageerror", lambda e: errors.append(f"host: {e}"))
        callee.on("pageerror", lambda e: errors.append(f"callee: {e}"))

        login(host, HOST)
        login(callee, CALLEE)
        open_calls_tab(host)

        run_round("1. The receiver hangs up", host, callee, "receiver")
        run_round("2. The caller hangs up", host, callee, "caller")

        check("no uncaught page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    print(f"\n{passed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
