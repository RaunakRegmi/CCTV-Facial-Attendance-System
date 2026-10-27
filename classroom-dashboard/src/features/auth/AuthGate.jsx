import { useEffect, useState } from 'react';
import { ArrowRight, Eye, EyeOff, GraduationCap, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api } from '../../shared/api';
import { lazy, Suspense } from 'react';
const Dashboard = lazy(() => import('../attendance/TeacherDashboard'));

export default function AuthGate() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    let active = true;
    api('/auth/me').then(value => { if (active) setUser(value); })
      .catch(err => { if (active && err.status !== 401) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    const expired = () => { setUser(null); setError('Your session expired. Please sign in again.'); };
    window.addEventListener('session-expired', expired);
    return () => { active = false; window.removeEventListener('session-expired', expired); };
  }, []);
  async function login(event) {
    event.preventDefault();
    setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const value = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) });
      setUser(value);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    try { await api('/auth/logout', { method: 'POST' }); setUser(null); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  if (loading) return <p role="status" className="p-8">Checking your session…</p>;
  if (user) return <>
    {error && <p role="alert" className="bg-red-50 p-3 text-red-700">{error}</p>}
    <Suspense fallback={<div className="empty-state">Opening your workspace…</div>}><Dashboard user={user} onLogout={logout} signingOut={busy} /></Suspense>
  </>;
  return <main className="login-page">
    <section className="login-story"><a className="brand" href="#sign-in"><span className="brand-icon"><GraduationCap size={25} /></span><span>Attendly<small>CLASSROOM WORKSPACE</small></span></a><div className="login-story-body"><p className="eyebrow">A LITTLE MORE CLARITY. EVERY DAY.</p><h1>More time to teach.<br />A clearer view of<br /><em>every classroom.</em></h1><p>Bring attendance and classroom insights together in one thoughtful workspace.</p><div className="login-illustration" aria-hidden="true"><div className="illustration-title"><span className="status-dot online" />Your classroom, connected<span>● ● ●</span></div><div className="illustration-row"><span /><i /><b>Present</b></div><div className="illustration-row"><span /><i /><b>Present</b></div><div className="illustration-row"><span /><i /><b>Present</b></div><div className="illustration-bars">{[30, 48, 42, 64, 55, 73, 65, 85, 76, 90, 84, 94].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div></div></div><div className="login-story-footer"><ShieldCheck size={17} />Designed for your institution. Built around your classroom.</div></section>
    <section className="login-form-section" id="sign-in"><div className="login-form-wrap"><span className="login-lock"><LockKeyhole size={23} /></span><p className="eyebrow">YOUR WORKSPACE AWAITS</p><h2>Welcome back.</h2><p className="login-subtitle">Sign in with your institution account to continue.</p><form onSubmit={login}>
      <label>Email address<input name="email" type="email" required autoComplete="username" placeholder="you@institution.edu" disabled={busy} /></label>
      <label>Password<div className="password-input"><input name="password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password" placeholder="Enter your password" disabled={busy} /><button type="button" className="icon-button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
      {error && <p role="alert" className="login-error">{error}</p>}
      <button disabled={busy} className="button primary login-submit">{busy ? 'Signing in…' : 'Sign in to workspace'}<ArrowRight size={17} /></button>
    </form><p className="account-help">Need access or a password reset?<br /><strong>Contact your institution administrator.</strong></p><div className="login-security"><ShieldCheck size={15} />Secure access. Your classroom data stays protected.</div></div><footer>Attendly · Attendance, with perspective.</footer></section>
  </main>;
}
