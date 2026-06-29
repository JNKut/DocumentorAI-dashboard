import { useState, useEffect, useCallback } from 'react';

interface Service {
  id: string;
  name: string;
  url: string;
  password: string;
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
}

type ServiceStatus = { status: 'loading' } | { status: 'ok'; data: Analytics } | { status: 'error'; message: string };

const SERVICES_KEY = 'dai_dash_services';
const TOKEN_KEY = 'dai_dash_token';
const DASH_PASSWORD = import.meta.env.VITE_DASHBOARD_PASSWORD ?? '';

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

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');

  const [services, setServices] = useState<Service[]>(() => {
    try { return JSON.parse(localStorage.getItem(SERVICES_KEY) ?? '[]'); } catch { return []; }
  });
  const [results, setResults] = useState<Record<string, ServiceStatus>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const isAuthed = DASH_PASSWORD ? token === DASH_PASSWORD : true;

  const fetchAll = useCallback((svcs: Service[]) => {
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
  }, []);

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

  function handleAddService(e: React.FormEvent) {
    e.preventDefault();
    const svc: Service = { id: crypto.randomUUID(), name: newName.trim(), url: newUrl.trim(), password: newPassword };
    const updated = [...services, svc];
    setServices(updated);
    localStorage.setItem(SERVICES_KEY, JSON.stringify(updated));
    setNewName(''); setNewUrl(''); setNewPassword('');
    setAddOpen(false);
    fetchAll([svc]);
  }

  function handleRemove(id: string) {
    const updated = services.filter(s => s.id !== id);
    setServices(updated);
    localStorage.setItem(SERVICES_KEY, JSON.stringify(updated));
    setResults(prev => { const n = { ...prev }; delete n[id]; return n; });
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

      <div className="px-6 py-6 space-y-6">
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
                      <th className="px-3 pb-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {services.map(svc => {
                      const res = results[svc.id];
                      const isExpanded = expanded === svc.id;
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
                            <td className="px-3 py-3 text-right">
                              <button onClick={() => handleRemove(svc.id)} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
                            </td>
                          </tr>

                          {/* Expanded detail rows */}
                          {isExpanded && res?.status === 'ok' && (
                            <tr key={`${svc.id}-detail`}>
                              <td colSpan={12} className="bg-gray-50 px-6 py-4 border-b border-gray-200">
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
