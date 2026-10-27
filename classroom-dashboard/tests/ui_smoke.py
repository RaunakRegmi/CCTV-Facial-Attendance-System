"""Browser smoke checks with synthetic API fixtures, never production accounts.
Run: python classroom-dashboard/tests/ui_smoke.py http://127.0.0.1:5173
Requires Python Playwright and an installed Chromium browser.
"""
import json
import sys
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173'
now = datetime.now(timezone.utc).isoformat()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1050}, device_scale_factor=1)
    failures = []
    page.on('pageerror', lambda error: (failures.append(str(error)), print('Browser error:', error, flush=True)))
    state = {'signed': False, 'role': 'admin', 'offline': False}
    def handle(route):
        path = route.request.url.split('/api', 1)[1]
        status = 200
        if path == '/auth/me':
            status = 200 if state['signed'] else 401
            body = {'uid': 'test', 'role': state['role']} if state['signed'] else {'detail': 'Sign in required'}
        elif path == '/auth/login':
            state['signed'] = True
            body = {'uid': 'test', 'role': state['role']}
        elif path == '/auth/logout':
            state['signed'] = False
            body = {'status': 'signed_out'}
        elif state['offline']:
            status, body = 503, {'detail': 'Service unavailable'}
        elif path == '/classes':
            body = [{'id': 'CS-101', 'class_name': 'Introduction to Computer Science', 'room': 'Room 204', 'start_time': '09:00', 'last_active_startup': now[:11] + '00:00:00+00:00', 'last_heartbeat': now}]
        elif path.startswith('/students'):
            body = [{'id': 'S-001', 'full_name': 'Alex Morgan', 'student_id': 'S-001', 'enrolled_classes': ['CS-101']}, {'id': 'S-002', 'full_name': 'Mia Chen', 'student_id': 'S-002', 'enrolled_classes': ['CS-101']}]
        else:
            body = {'items': [{'id': 'log1', 'student_name': 'Alex Morgan', 'timestamp': now, 'status': 'Present', 'attention_score': 82}], 'next_cursor': None}
        route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
    page.route('**/api/**', handle)
    page.goto(url)
    page.get_by_role('heading', name='Welcome back.').wait_for()
    page.screenshot(path='/tmp/attendly-login.png', full_page=True)
    page.get_by_label('Email address').fill('admin@example.test')
    page.get_by_label('Password', exact=True).fill('test-password')
    page.get_by_role('button', name='Show password').click()
    assert page.locator('input[name=password]').get_attribute('type') == 'text'
    page.get_by_role('button', name='Sign in to workspace').click()
    page.get_by_role('heading', name='Your classroom, in focus.').wait_for()
    page.screenshot(path='/tmp/attendly-debug.png', full_page=True)
    page.get_by_role('row').filter(has_text='Alex Morgan').wait_for()
    page.locator('.recharts-surface').wait_for()
    page.screenshot(path='/tmp/attendly-dashboard.png', full_page=True)
    page.get_by_label('Search students').fill('Mia')
    assert page.get_by_role('row').filter(has_text='Mia Chen').count() == 1
    assert page.get_by_role('row').filter(has_text='Alex Morgan').count() == 0
    page.get_by_label('Search students').fill('')
    page.get_by_role('button', name='Absent', exact=True).click()
    assert page.get_by_role('row').filter(has_text='Alex Morgan').count() == 0
    page.get_by_role('button', name='All', exact=True).click()
    with page.expect_download() as download:
        page.get_by_role('button', name='Export roster', exact=True).click()
    assert download.value.suggested_filename.endswith('.csv')
    page.get_by_role('button', name='Class & student management').click()
    page.get_by_role('heading', name='Admin Panel').wait_for()
    page.screenshot(path='/tmp/attendly-admin.png', full_page=True)
    page.get_by_role('button', name='Overview', exact=True).click()
    page.get_by_role('button', name='Use dark theme').click()
    assert page.locator('html').evaluate('(element) => element.classList.contains("dark")')
    page.screenshot(path='/tmp/attendly-dark.png', full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.screenshot(path='/tmp/attendly-mobile.png', full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.get_by_role('button', name='Open navigation').click()
    page.get_by_role('button', name='Sign out', exact=True).click()
    page.get_by_role('heading', name='Welcome back.').wait_for()
    state['role'] = 'teacher'
    page.get_by_label('Email address').fill('teacher@example.test')
    page.get_by_label('Password', exact=True).fill('test-password')
    page.get_by_role('button', name='Sign in to workspace').click()
    page.get_by_role('row').filter(has_text='Alex Morgan').wait_for()
    assert page.get_by_role('button', name='Class & student management').count() == 0
    state['offline'] = True
    page.get_by_role('button', name='Refresh', exact=True).click()
    page.get_by_role('alert').wait_for()
    assert page.get_by_role('row').filter(has_text='Alex Morgan').count() == 0
    assert not failures, failures
    browser.close()
    print('Browser smoke checks passed: login, dashboard, search, filters, CSV, admin, dark theme, mobile, logout, teacher permissions, API failure.')
