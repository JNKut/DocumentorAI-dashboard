import { useState, useEffect, useCallback } from 'react';

interface Service {
  id: string;
  name: string;
  url: string;
  password: string;
  railwayProjectId?: string;
  railwayServiceId?: string;
}

interface PeriodStats {
  conversations: number;
  messages: number;
}

interface Analytics {
  totals: {
    conversations: number;
    userMessages: number;
    assistantMessages: number;
    avgMessagesPerConversation: number;
  };
  byPeriod: {
    today: PeriodStats;
    thisWeek: PeriodStats;
    thisMonth: PeriodStats;
    allTime: PeriodStats;
  };
  documents: Array<{ originalName: string; size: number; chunkCount: number; createdAt: string }>;
  recentConversations: Array<{ sessionId: string; messageCount: number; createdAt: string }>;
  costs?: {
    openai: { today: number; thisWeek: number; thisMonth: number; allTime: number };
  };
}

type ServiceStatus = { status: 'loading' } | { status: 'ok'; data: Analytics } | { status: 'error'; message: string };
type CostStatus = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; value: number } | { status: 'error'; message: string };

const SERVICES_KEY = 'dai_dash_services';
const TOKEN_KEY = 'dai_dash_token';
const RAILWAY_TOKEN_KEY = 'dai_dash_railway_token';
const DASH_PASSWORD = import.meta.env.VITE_DASHBOARD_PASSWORD ?? '';

// Railway usage-based pricing rates. Verify at railway.com/pricing if numbers look wrong.
const RAILWAY_CPU_PER_MIN = 0.000463;   // USD per vCPU-minute
const RAILWAY_MEM_PER_MIN = 0.000231;   // USD per GB-minute

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortSession(sessionId: string) {
  return sessionId.replace('session_', '').slice(0, 14) + '…';
}

function fmtUSD(n: number) {
  if (n < 0.001) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

async function fetchEnvironmentId(projectId: string, token: string): Promise<string> {
  const query = `{ project(id: "${projectId}") { environments { edges { node { id name } } } } }`;
  const res = await fetch('/api/railway-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, query }),
  });
  const json = await res.json();
  const edges = json?.data?.project?.environments?.edges;
  if (!edges?.length) throw new Error('No environments found for this project');
  // Prefer the "production" environment, fall back to the first one
  const prod = edges.find((e: any) => e.node.name === 'production');
  return (prod ?? edges[0]).node.id;
}

async function fetchRailwayCost(svc: Service, token: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const endDate = now.toISOString();

  const environmentId = await fetchEnvironmentId(svc.railwayProjectId!, token);

  const metricsQuery = `{
    metrics(
      projectId: "${svc.railwayProjectId}"
      serviceId: "${svc.railwayServiceId}"
      environmentId: "${environmentId}"
      startDate: "${startOfMonth}"
      endDate: "${endDate}"
      measurements: [CPU_USAGE, MEMORY_USAGE_GB]
    ) {
      measurement
      values { ts value }
    }
  }`;

  const mRes = await fetch('/api/railway-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, query: metricsQuery }),
  });
  const mJson = await mRes.json();

  if (mJson?.errors?.length) throw new Error(mJson.errors[0].message);

  const metrics: Array<{ measurement: string; values: Array<{ ts: string; value: number }> }> =
    mJson?.data?.metrics ?? [];

  const cpuMetrics = metrics.find(m => m.measurement === 'CPU_USAGE');
  const memMetrics = metrics.find(m => m.measurement === 'MEMORY_USAGE_GB');

  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  const avgCpu = avg((cpuMetrics?.values ?? []).map(v => v.value));
  const avgMem = avg((memMetrics?.values ?? []).map(v => v.value));

  const minutesSinceStart = (now.getTime() - new Date(now.getFullYear(), now.getMonth(), 1).getTime()) / 60000;

  return avgCpu * minutesSinceStart * RAILWAY_CPU_PER_MIN + avgMem * minutesSinceStart * RAILWAY_MEM_PER_MIN;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');

  const [railwayToken, setRailwayToken] = useState(() => localStorage.getItem(RAILWAY_TOKEN_KEY) ?? '');
  const [railwayTokenInput, setRailwayTokenInput] = useState('');
  const [showRailwaySettings, setShowRailwaySettings] = useState(false);

  const [services, setServices] = useState<Service[]>(() => {
    try { return JSON.parse(localStorage.getItem(SERVICES_KEY) ?? '[]'); } catch { return []; }
  });
  const [results, setResults] = useState<Record<string, ServiceStatus>>({});
  const [railwayCosts, setRailwayCosts] = useState<Record<string, CostStatus>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRailwayProjectId, setNewRailwayProjectId] = useState('');
  const [newRailwayServiceId, setNewRailwayServiceId] = useState('');

  const isAuthed = DASH_PASSWORD ? token === DASH_PASSWORD : true;

  const fetchRailwayCosts = useCallback((svcs: Service[], tkn: string) => {
    if (!tkn) return;
    svcs.forEach(svc => {
      if (!svc.railwayProjectId || !svc.railwayServiceId) return;
      setRailwayCosts(prev => ({ ...prev, [svc.id]: { status: 'loading' } }));
      fetchRailwayCost(svc, tkn)
        .then(value => setRailwayCosts(prev => ({ ...prev, [svc.id]: { status: 'ok', value } })))
        .catch(e => setRailwayCosts(prev => ({ ...prev, [svc.id]: { status: 'error', message: e.message } })));
    });
  }, []);

  const fetchAll = useCallback((svcs: Service[], rlwyTkn?: string) => {
    svcs.forEach(svc => {
      setResults(prev => ({ ...prev, [svc.id]: { status: 'loading' } }));
      fetch(`${svc.url.replace(/\/$/, '')}/api/admin/analytics`, {
        headers: { Authorization: `Bearer ${svc.password}` },
      })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: Analytics) => setResults(prev => ({ ...prev, [svc.id]: { status: 'ok', data } })))
        .catch(e => setResults(prev => ({ ...prev, [svc.id]: { status: 'error', message: e.message } })));
    });
    fetchRailwayCosts(svcs, rlwyTkn ?? railwayToken);
  }, [railwayToken, fetchRailwayCosts]);

  useEffect(() => {
    if (isAuthed && services.length > 0) fetchAll(services);
  }, [isAuthed]);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (passwordInput === DASH_PASSWORD) {
      setToken(passwordInput);
      localStorage.setItem(TOKEN_KEY, passwordInput);
      setLoginError('');
    } else {
      setLoginError('Incorrect password');
    }
  }

  function handleSaveRailwayToken(e: React.FormEvent) {
    e.preventDefault();
    const tkn = railwayTokenInput.trim();
    setRailwayToken(tkn);
    localStorage.setItem(RAILWAY_TOKEN_KEY, tkn);
    setRailwayTokenInput('');
    setShowRailwaySettings(false);
    fetchRailwayCosts(services, tkn);
  }

  function handleAddService(e: React.FormEvent) {
    e.preventDefault();
    const svc: Service = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      url: newUrl.trim(),
      password: newPassword,
      railwayProjectId: newRailwayProjectId.trim() || undefined,
      railwayServiceId: newRailwayServiceId.trim() || undefined,
    };
    const updated = [...services, svc];
    setServices(updated);
    localStorage.setItem(SERVICES_KEY, JSON.stringify(updated));
    setNewName(''); setNewUrl(''); setNewPassword('');
    setNewRailwayProjectId(''); setNewRailwayServiceId('');
    setAddOpen(false);
    fetchAll([svc]);
  }

  function handleRemove(id: string) {
    const updated = services.filter(s => s.id !== id);
    setServices(updated);
    localStorage.setItem(SERVICES_KEY, JSON.stringify(updated));
    setResults(prev => { const n = { ...prev }; delete n[id]; return n; });
    setRailwayCosts(prev => { const n = { ...prev }; delete n[id]; return n; });
  }

  function handleRefresh() {
    fetchAll(services);
  }

  if (!isAuthed) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-sm">
          <h1 className="text-xl font-semibold text-gray-900 mb-1">DocumentorAI Dashboard</h1>
          <p className="text-sm text-gray-500 mb-6">Enter your dashboard password to continue.</p>
          <form onSubmit={handleLogin} className="space-y-3">
            <input
              type="password"
              placeholder="Password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            {loginError && <p className="text-xs text-red-600">{loginError}</p>}
            <button type="submit" className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700">
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">DocumentorAI Dashboard</h1>
          <p className="text-xs text-gray-500">{services.length} service{services.length !== 1 ? 's' : ''} registered</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setRailwayTokenInput(railwayToken); setShowRailwaySettings(v => !v); }}
            className={`text-sm px-3 py-1.5 border rounded-lg ${railwayToken ? 'border-green-300 text-green-700 hover:bg-green-50' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            title={railwayToken ? 'Railway token configured' : 'Set Railway API token for cost estimates'}
          >
            {railwayToken ? '✓ Railway' : 'Railway token'}
          </button>
          <button
            onClick={handleRefresh}
            className="text-sm px-3 py-1.5 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50"
          >
            Refresh
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            + Add Service
          </button>
          {DASH_PASSWORD && (
            <button
              onClick={() => { setToken(''); localStorage.removeItem(TOKEN_KEY); }}
              className="text-sm px-3 py-1.5 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50"
            >
              Logout
            </button>
          )}
        </div>
      </div>

      <div className="px-6 py-6 space-y-4">
        {/* Railway token settings panel */}
        {showRailwaySettings && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">Railway API Token</h2>
            <p className="text-xs text-gray-500 mb-3">
              Used to fetch usage metrics for Railway cost estimates. Generate one at{' '}
              <a href="https://railway.com/account/tokens" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                railway.com/account/tokens
              </a>{' '}
              → click <strong>Create token</strong> → give it a name (e.g. "Dashboard") → copy the token.
            </p>
            <form onSubmit={handleSaveRailwayToken} className="flex gap-2">
              <input
                type="password"
                placeholder="••••••••••••••••"
                value={railwayTokenInput}
                onChange={e => setRailwayTokenInput(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                Save
              </button>
              {railwayToken && (
                <button
                  type="button"
                  onClick={() => { setRailwayToken(''); localStorage.removeItem(RAILWAY_TOKEN_KEY); setShowRailwaySettings(false); }}
                  className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm hover:bg-red-50"
                >
                  Remove
                </button>
              )}
              <button type="button" onClick={() => setShowRailwaySettings(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
            </form>
          </div>
        )}

        {/* Add Service Modal */}
        {addOpen && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
            <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
              <h2 className="text-base font-semibold text-gray-900 mb-4">Add Service</h2>
              <form onSubmit={handleAddService} className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Name</label>
                  <input required value={newName} onChange={e => setNewName(e.target.value)}
                    placeholder="DocumentorAI" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">URL</label>
                  <input required value={newUrl} onChange={e => setNewUrl(e.target.value)}
                    placeholder="https://your-service.up.railway.app" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Admin Password</label>
                  <input required type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    placeholder="••••••••" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="border-t border-gray-100 pt-3">
                  <p className="text-xs text-gray-500 mb-2">
                    <strong>Railway IDs</strong> <span className="font-normal">(optional — needed for hosting cost estimates)</span>
                    <br />Find them in your Railway URL: <code className="bg-gray-100 px-1 rounded">railway.com/project/<strong>PROJECT_ID</strong>/service/<strong>SERVICE_ID</strong></code>
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1">Railway Project ID</label>
                      <input value={newRailwayProjectId} onChange={e => setNewRailwayProjectId(e.target.value)}
                        placeholder="c9487815-..." className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-700 block mb-1">Railway Service ID</label>
                      <input value={newRailwayServiceId} onChange={e => setNewRailwayServiceId(e.target.value)}
                        placeholder="d8edb15d-..." className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700">Add</button>
                  <button type="button" onClick={() => setAddOpen(false)} className="flex-1 border border-gray-300 rounded-lg py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {services.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            <p className="text-base font-medium text-gray-500 mb-1">No services yet</p>
            <p className="text-sm">Click <strong>+ Add Service</strong> to register a Railway deployment.</p>
          </div>
        ) : (
          <>
            {/* Main analytics table */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">Service</th>
                      <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap" colSpan={2}>Today</th>
                      <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap border-l border-gray-100" colSpan={2}>This Week</th>
                      <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap border-l border-gray-100" colSpan={2}>This Month</th>
                      <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap border-l border-gray-100" colSpan={2}>All Time</th>
                      <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap border-l border-gray-100">Avg Msgs</th>
                      <th className="text-center px-3 py-3 font-medium text-gray-600 whitespace-nowrap">Docs</th>
                      <th className="text-center px-3 py-3 font-medium text-emerald-700 whitespace-nowrap border-l border-emerald-100 bg-emerald-50">OpenAI (mo)</th>
                      <th className="text-center px-3 py-3 font-medium text-emerald-700 whitespace-nowrap bg-emerald-50">Railway (mo)</th>
                      <th className="text-center px-3 py-3 font-medium text-emerald-700 whitespace-nowrap bg-emerald-50">Total (mo)</th>
                      <th className="px-3 py-3"></th>
                    </tr>
                    <tr className="bg-gray-50 border-b border-gray-200 text-xs text-gray-400">
                      <th className="px-4 pb-2"></th>
                      <th className="text-center px-3 pb-2">Conv</th>
                      <th className="text-center px-3 pb-2">Msgs</th>
                      <th className="text-center px-3 pb-2 border-l border-gray-100">Conv</th>
                      <th className="text-center px-3 pb-2">Msgs</th>
                      <th className="text-center px-3 pb-2 border-l border-gray-100">Conv</th>
                      <th className="text-center px-3 pb-2">Msgs</th>
                      <th className="text-center px-3 pb-2 border-l border-gray-100">Conv</th>
                      <th className="text-center px-3 pb-2">Msgs</th>
                      <th className="text-center px-3 pb-2 border-l border-gray-100">/Conv</th>
                      <th className="text-center px-3 pb-2"></th>
                      <th className="text-center px-3 pb-2 border-l border-emerald-100 bg-emerald-50 text-emerald-600">API cost</th>
                      <th className="text-center px-3 pb-2 bg-emerald-50 text-emerald-600">hosting est.</th>
                      <th className="text-center px-3 pb-2 bg-emerald-50 text-emerald-600">combined</th>
                      <th className="px-3 pb-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {services.map(svc => {
                      const res = results[svc.id];
                      const railwayCost = railwayCosts[svc.id];
                      const isExpanded = expanded === svc.id;
                      const openaiMonthly = res?.status === 'ok' ? (res.data.costs?.openai.thisMonth ?? null) : null;
                      const railwayMonthly = railwayCost?.status === 'ok' ? railwayCost.value : null;
                      const totalMonthly = openaiMonthly !== null && railwayMonthly !== null
                        ? openaiMonthly + railwayMonthly
                        : openaiMonthly !== null ? openaiMonthly : null;

                      return (
                        <>
                          <tr key={svc.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                              <button onClick={() => setExpanded(isExpanded ? null : svc.id)} className="flex items-center gap-1.5 hover:text-blue-600">
                                <span className={`text-gray-400 text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                                {svc.name}
                              </button>
                            </td>
                            {res?.status === 'loading' && (
                              <td colSpan={10} className="px-3 py-3 text-center text-gray-400 text-xs">Loading…</td>
                            )}
                            {res?.status === 'error' && (
                              <td colSpan={10} className="px-3 py-3 text-center text-red-500 text-xs">Unreachable — {res.message}</td>
                            )}
                            {res?.status === 'ok' && (() => {
                              const d = res.data;
                              return (
                                <>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700">{d.byPeriod.today.conversations}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700">{d.byPeriod.today.messages}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700 border-l border-gray-100">{d.byPeriod.thisWeek.conversations}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700">{d.byPeriod.thisWeek.messages}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700 border-l border-gray-100">{d.byPeriod.thisMonth.conversations}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700">{d.byPeriod.thisMonth.messages}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700 border-l border-gray-100">{d.byPeriod.allTime.conversations}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700">{d.byPeriod.allTime.messages}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700 border-l border-gray-100">{d.totals.avgMessagesPerConversation}</td>
                                  <td className="px-3 py-3 text-center tabular-nums text-gray-700">{d.documents.length}</td>
                                </>
                              );
                            })()}
                            {!res && <td colSpan={10} />}

                            {/* Cost columns */}
                            <td className="px-3 py-3 text-center tabular-nums text-emerald-700 border-l border-emerald-100 bg-emerald-50/30 whitespace-nowrap">
                              {openaiMonthly !== null ? fmtUSD(openaiMonthly) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-3 py-3 text-center tabular-nums text-emerald-700 bg-emerald-50/30 whitespace-nowrap">
                              {!svc.railwayProjectId || !svc.railwayServiceId ? (
                                <span className="text-gray-300">—</span>
                              ) : !railwayToken ? (
                                <span className="text-gray-400 text-xs">no token</span>
                              ) : railwayCost?.status === 'loading' ? (
                                <span className="text-gray-400 text-xs">…</span>
                              ) : railwayCost?.status === 'error' ? (
                                <span className="text-red-400 text-xs" title={railwayCost.message}>err</span>
                              ) : railwayCost?.status === 'ok' ? (
                                `~${fmtUSD(railwayCost.value)}`
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-3 text-center tabular-nums font-medium text-emerald-800 bg-emerald-50/30 whitespace-nowrap">
                              {totalMonthly !== null ? fmtUSD(totalMonthly) : <span className="text-gray-300">—</span>}
                            </td>

                            <td className="px-3 py-3 text-right">
                              <button onClick={() => handleRemove(svc.id)} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
                            </td>
                          </tr>

                          {/* Expanded detail rows */}
                          {isExpanded && res?.status === 'ok' && (
                            <tr key={`${svc.id}-detail`}>
                              <td colSpan={15} className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                                <div className="grid grid-cols-2 gap-6">
                                  {/* Recent conversations */}
                                  <div>
                                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recent Conversations</h3>
                                    {res.data.recentConversations.length === 0 ? (
                                      <p className="text-xs text-gray-400">No conversations yet</p>
                                    ) : (
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="text-gray-400">
                                            <th className="text-left pb-1 font-medium">Session</th>
                                            <th className="text-center pb-1 font-medium">Msgs</th>
                                            <th className="text-right pb-1 font-medium">Started</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                          {res.data.recentConversations.map((conv, i) => (
                                            <tr key={i}>
                                              <td className="py-1 text-gray-600 font-mono">{shortSession(conv.sessionId)}</td>
                                              <td className="py-1 text-center text-gray-700">{conv.messageCount}</td>
                                              <td className="py-1 text-right text-gray-500">{formatDate(conv.createdAt)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>

                                  {/* Documents */}
                                  <div>
                                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Knowledge Base</h3>
                                    {res.data.documents.length === 0 ? (
                                      <p className="text-xs text-gray-400">No documents uploaded</p>
                                    ) : (
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="text-gray-400">
                                            <th className="text-left pb-1 font-medium">File</th>
                                            <th className="text-center pb-1 font-medium">Chunks</th>
                                            <th className="text-right pb-1 font-medium">Size</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                          {res.data.documents.map((doc, i) => (
                                            <tr key={i}>
                                              <td className="py-1 text-gray-700 truncate max-w-[160px]">{doc.originalName}</td>
                                              <td className="py-1 text-center text-gray-600">{doc.chunkCount}</td>
                                              <td className="py-1 text-right text-gray-500">{formatBytes(doc.size)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-400">
                Railway (mo) is a usage-based estimate and excludes your flat Railway plan fee. OpenAI cost tracked from service deploy date only.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
