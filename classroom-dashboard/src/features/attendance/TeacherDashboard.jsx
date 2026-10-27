import { lazy, Suspense, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowUpRight, BookOpen, CalendarDays, Check, ChevronRight, CircleHelp, Clock3, GraduationCap, LayoutDashboard, LogOut, Menu, Moon, RefreshCw, Search, ShieldCheck, Sun, Users, X } from 'lucide-react';
import { useAttendance } from './useAttendance';
import { isActive, formatLastActive } from './attendance';
import { useTheme } from '../../shared/theme';
const AdminPanel = lazy(() => import('../admin/AdminPanel'));
const AttentionChart = lazy(() => import('./AttentionChart'));

function Metric({ label, value, detail, icon: Icon, tone = '', children }) {
  return <article className={`metric ${tone}`}><div className="metric-top"><span>{label}</span><Icon size={19} /></div><strong>{value}</strong><div className="metric-bottom"><span>{detail}</span>{children}</div></article>;
}

export default function TeacherDashboard({ user, onLogout, signingOut }) {
  const data = useAttendance();
  const [dark, setDark] = useTheme();
  const [view, setView] = useState('dashboard');
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const { classes, classInfo, classId, now, loading, error, roster, visibleRoster, presentCount, lateCount } = data;
  const unavailable = loading || error || !classInfo;
  const percentage = roster.length ? Math.round(presentCount / roster.length * 100) : 0;
  function navigate(next) { setView(next); setMenu(false); }
  return <div className="workspace">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {menu && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenu(false)} />}
    <aside className={`workspace-sidebar ${menu ? 'is-open' : ''}`} aria-label="Main navigation">
      <a href="#main-content" className="brand"><span className="brand-icon"><GraduationCap size={23} /></span><span>Attend<span className="brand-accent">ly</span><small>CLASSROOM WORKSPACE</small></span></a>
      <button className="mobile-close icon-button" aria-label="Close navigation" onClick={() => setMenu(false)}><X size={20} /></button>
      <div className="workspace-label"><span className="workspace-avatar">C</span><div>Campus workspace<small>{user.role === 'admin' ? 'Administrator access' : 'Teacher access'}</small></div><ShieldCheck size={16} /></div>
      <p className="nav-label">WORKSPACE</p>
      <nav className="primary-nav">
        <button className={view === 'dashboard' ? 'selected' : ''} aria-current={view === 'dashboard' ? 'page' : undefined} onClick={() => navigate('dashboard')}><LayoutDashboard size={18} />Overview<ChevronRight size={15} /></button>
        {user.role === 'admin' && <button className={view === 'admin' ? 'selected' : ''} aria-current={view === 'admin' ? 'page' : undefined} onClick={() => navigate('admin')}><Users size={18} />Class & student management</button>}
      </nav>
      <div className="nav-label class-label">YOUR CLASSES <span>{classes.length}</span></div>
      <nav className="class-nav" aria-label="Classes">
        {data.classesFeed.status === 'loading' && <p className="nav-empty">Loading classes…</p>}
        {data.classesFeed.status === 'error' && <p className="nav-empty">Classes unavailable. Use Refresh to retry.</p>}
        {data.classesFeed.status === 'ready' && !classes.length && <p className="nav-empty">Your assigned classes will appear here.</p>}
        {classes.map(cls => <button key={cls.id} className={cls.id === classId ? 'selected' : ''} onClick={() => { data.setSelectedClass(cls.id); navigate('dashboard'); }} aria-current={cls.id === classId ? 'true' : undefined}><span className="class-monogram">{cls.id.slice(0, 2)}</span><span className="class-name">{cls.id}<small>{cls.name}</small></span><span className={`status-dot ${isActive(cls, now) ? 'online' : ''}`} /></button>)}
      </nav>
      <div className="sidebar-bottom"><button className="help-button" onClick={() => setHelp(!help)}><CircleHelp size={18} />Workspace guide<ArrowUpRight size={15} /></button><div className="profile"><span className="profile-avatar">{user.role === 'admin' ? 'A' : 'T'}</span><div>{user.role === 'admin' ? 'Administrator' : 'Teacher'}<small>Institution account</small></div><button className="icon-button" title="Sign out" aria-label="Sign out" disabled={signingOut} onClick={onLogout}><LogOut size={17} /></button></div></div>
    </aside>
    <div className="workspace-body">
      <header className="workspace-topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu size={20} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{view === 'admin' ? 'Management' : 'Overview'}</strong></div><div className="topbar-actions"><span className="today"><CalendarDays size={15} />{new Date(now).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><button className="icon-button" onClick={() => setDark(!dark)} aria-label={dark ? 'Use light theme' : 'Use dark theme'}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button></div></header>
      <main id="main-content" className="workspace-main">
        {help && <div className="notice" role="status"><CircleHelp size={20} /><div><strong>Your classroom at a glance</strong><p>Select a class to view its current session. Data refreshes every 15 seconds. “Present” means a student has been detected in this session. Attention is an estimated signal. Contact your administrator for access changes.</p></div><button className="icon-button" aria-label="Dismiss guide" onClick={() => setHelp(false)}><X size={17} /></button></div>}
        {view === 'admin' && user.role === 'admin' ? <Suspense fallback={<div className="empty-state">Loading management…</div>}><div className="admin-workspace"><AdminPanel classes={classes} classesStatus={data.classesFeed.status} /></div></Suspense> : <>
          <div className="page-heading"><div><p className="eyebrow">CLASSROOM INSIGHTS</p><h1>Your classroom, in focus.</h1><p>A clear view of attendance and engagement, all in one place.</p></div><button className="button secondary" onClick={data.refresh}><RefreshCw size={16} />Refresh</button></div>
          {data.classesFeed.status === 'error' || error ? <div className="notice error" role="alert"><Activity size={20} /><div><strong>We couldn’t load your classroom data</strong><p>{(data.classesFeed.error || error)?.message} — refresh to try again. Metrics are unavailable until the connection is restored.</p></div></div> : null}
          {data.notice && <div className="notice" role="status">{data.notice}</div>}
          {!classInfo ? <div className="empty-state"><BookOpen size={36} /><h2>{data.classesFeed.status === 'loading' ? 'Loading your workspace' : 'Ready for your first class'}</h2><p>{user.role === 'admin' ? 'Create a class and enroll students to get started.' : 'Your administrator can assign classes to your account.'}</p>{user.role === 'admin' && <button className="button primary" onClick={() => navigate('admin')}>Manage classes<ArrowUpRight size={16} /></button>}</div> : <>
            <section className="class-banner"><div className="class-banner-icon"><BookOpen size={25} /></div><div className="class-banner-copy"><div className="class-title"><h2>{classInfo.name}</h2><span className="tag">{classId}</span></div><p>{data.classMeta}</p></div><span className={`session-badge ${isActive(classInfo, now) ? 'live' : ''}`}><span className="status-dot" />{isActive(classInfo, now) ? 'Session active' : 'Session inactive'}</span></section>
            <section className="metrics-grid" aria-label="Classroom summary" aria-busy={loading}>
              <Metric label="Students present" value={unavailable ? '—' : <>{presentCount}<span> / {roster.length}</span></>} detail={unavailable ? 'Awaiting classroom data' : `${percentage}% attendance rate`} icon={Users} tone="highlight"><div className="mini-progress"><i style={{ width: `${unavailable ? 0 : percentage}%` }} /></div></Metric>
              <Metric label="Students absent" value={unavailable ? '—' : roster.length - presentCount} detail="Not yet detected this session" icon={BookOpen} />
              <Metric label="Late arrivals" value={unavailable ? '—' : lateCount} detail={classInfo.startTime ? 'After the 5-minute grace period' : 'No class start time configured'} icon={Clock3} />
              <Metric label="Average attention" value={unavailable || !data.attention.length ? '—' : `${data.avgAttention}%`} detail="Estimated from detected activity" icon={Activity} />
            </section>
            <div className="insights-grid"><section className="panel chart-panel"><div className="panel-heading"><div><h2>Engagement over time</h2><p>Class average · current session</p></div><span className="chart-legend"><i />Attention</span></div><Suspense fallback={<div className="chart-empty">Loading chart…</div>}><AttentionChart data={unavailable ? [] : data.attention} average={data.avgAttention} dark={dark} loading={loading} error={error} /></Suspense><div className="chart-caption">Attention scores are estimates, not a measure of individual performance.</div></section>
            <section className="panel session-panel"><div className="panel-heading"><h2>Session details</h2><Activity size={18} /></div><div className={`connection-card ${isActive(classInfo, now) ? 'connected' : ''}`}><span className="status-dot" /><div>{isActive(classInfo, now) ? 'Camera worker active' : 'No active camera signal'}<small>{isActive(classInfo, now) ? 'Recent heartbeat received' : 'Waiting for the next heartbeat'}</small></div></div><dl><div><dt>Classroom</dt><dd>{classInfo.room || 'Not assigned'}</dd></div><div><dt>Scheduled start</dt><dd>{classInfo.startTime || 'Not configured'}</dd></div><div><dt>Last attendance log</dt><dd>{unavailable ? 'Unavailable' : data.lastSync || 'No logs yet'}</dd></div><div><dt>Session started</dt><dd>{formatLastActive(classInfo.lastActive, now)}</dd></div></dl><div className="session-footnote"><ShieldCheck size={17} /><span>Access restricted to your assigned classes.</span></div></section></div>
            <section className="panel roster-panel"><div className="panel-heading"><div><h2>Attendance roster <span className="count-badge">{unavailable ? '—' : roster.length}</span></h2><p>Student attendance for this session</p></div><button className="button secondary" onClick={() => data.handleExport('roster')} disabled={!!unavailable}><ArrowDownToLine size={16} />Export roster</button></div><div className="roster-toolbar"><div className="filter-group" aria-label="Filter attendance">{['All', 'Present', 'Absent', 'Late'].map(filter => <button key={filter} aria-pressed={data.filter === filter} className={filter === data.filter ? 'selected' : ''} onClick={() => data.setFilter(filter)}>{filter}</button>)}</div><label className="search-box"><Search size={17} /><input aria-label="Search students" placeholder="Search name or student ID…" value={data.search} onChange={event => data.setSearch(event.target.value)} /></label></div><div className="table-scroll"><table className="roster-table"><thead><tr><th>Student</th><th>Status</th><th>Arrival time</th><th>Last seen</th><th>Enrollment</th></tr></thead><tbody>{!unavailable && visibleRoster.map(student => <tr key={student.id}><td><div className="student-cell"><span className="student-avatar">{student.name.slice(0, 2).toUpperCase()}</span><div>{student.name}<small>{student.id}</small></div></div></td><td><span className={`attendance-badge ${student.status.toLowerCase()}`}>{student.status === 'Present' ? <Check size={13} /> : <span className="status-dot" />}{student.status}</span>{student.late && <span className="late-badge">Late</span>}</td><td>{student.arrival || '—'}</td><td>{student.lastSeen || '—'}</td><td><span className="enrollment">{student.enrolled ? 'Enrolled' : 'Unmatched log'}</span></td></tr>)}{(unavailable || !visibleRoster.length) && <tr><td colSpan={5} className="table-empty">{loading ? 'Loading attendance…' : error ? 'Attendance is unavailable. Refresh to retry.' : roster.length ? 'No students match your search or filter.' : 'No enrolled students or attendance logs in this session.'}</td></tr>}</tbody></table></div><div className="table-footer"><span>{unavailable ? 'Awaiting data' : `Showing ${visibleRoster.length} of ${roster.length} students`}</span><button disabled={!!unavailable || !data.logs.length} onClick={() => data.handleExport('report')}>Download detailed report<ArrowDownToLine size={14} /></button></div></section>
          </>}
          <footer className="workspace-footer"><span>Attendly · Classroom intelligence</span><span>Updates every 15 seconds</span></footer>
        </>}
      </main>
    </div>
  </div>;
}
