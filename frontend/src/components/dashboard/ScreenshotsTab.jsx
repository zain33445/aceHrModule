import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Image as ImageIcon, Search, User } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Select } from '../common';
import { SlideUp } from '../animations';
import api from '../../services/api';

const ScreenshotsTab = ({ user, isAdmin = false, employees = [] }) => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('today');
  const [selectedUserId, setSelectedUserId] = useState(isAdmin ? '' : user?.user_id);

  useEffect(() => {
    if (selectedUserId) {
      fetchLogs();
    } else {
      setLogs([]);
    }
  }, [filter, selectedUserId]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      let startDate, endDate;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const beforeYesterday = new Date(today);
      beforeYesterday.setDate(beforeYesterday.getDate() - 2);

      if (filter === 'today') {
        startDate = today.toISOString();
        endDate = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
      } else if (filter === 'yesterday') {
        startDate = yesterday.toISOString();
        endDate = new Date(yesterday.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
      } else if (filter === 'beforeYesterday') {
        startDate = beforeYesterday.toISOString();
        endDate = new Date(beforeYesterday.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
      }
      
      const res = await api.getMonitoringLogs({ 
        userId: selectedUserId, 
        startDate, 
        endDate, 
        includeScreenshot: true,
        limit: 100 
      });
      // Only keep records that actually have a screenshot
      const logsWithImages = (res.data.logs || []).filter(log => log.screenshot_b64);
      setLogs(logsWithImages);
    } catch (err) {
      console.error('Failed to fetch screenshots', err);
    }
    setLoading(false);
  };

  return (
    <SlideUp>
      <Card>
        <CardHeader className="flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 w-full">
            <h3 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
              <ImageIcon size={20} className="text-primary-600" />
              {isAdmin ? 'Employee Screenshots' : 'My Screenshots'}
            </h3>
            
            <div className="flex bg-neutral-100 p-1 rounded-lg overflow-x-auto w-full sm:w-auto">
              {[
                { id: 'today', label: 'Today' },
                { id: 'yesterday', label: 'Yesterday' },
                { id: 'beforeYesterday', label: 'Day Before Yesterday' },
                { id: 'all', label: 'All Time' }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`flex-1 sm:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all whitespace-nowrap ${
                    filter === f.id ? 'bg-white text-primary-600 shadow-sm' : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {isAdmin && (
            <div className="w-full flex flex-col sm:flex-row items-end gap-4 p-4 bg-neutral-50 rounded-xl border border-neutral-100">
              <div className="flex-1 w-full">
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Select Employee</label>
                <div className="relative">
                  <Select
                    value={selectedUserId}
                    onChange={setSelectedUserId}
                    className="w-full"
                    icon={User}
                    placeholder="Choose an employee..."
                    options={employees.map(emp => ({ value: emp.id, label: `${emp.name} (${emp.id})` }))}
                  />
                </div>
              </div>
              <Button 
                variant="primary" 
                onClick={fetchLogs} 
                disabled={loading || !selectedUserId}
                className="w-full sm:w-auto px-8"
              >
                <Search size={18} className="mr-2" />
                Fetch Activities
              </Button>
            </div>
          )}
        </CardHeader>
        <CardBody>
          {!selectedUserId ? (
            <div className="text-center py-16 bg-neutral-50/50 rounded-xl border border-dashed border-neutral-200">
              <User size={48} className="mx-auto text-neutral-300 mb-4" />
              <p className="font-medium text-neutral-600">Please select an employee to view their activities</p>
              <p className="text-sm text-neutral-400 mt-1 text-center max-w-xs mx-auto">
                Monitoring logs and screenshots will be displayed here once an employee is selected.
              </p>
            </div>
          ) : loading ? (
            <div className="text-center py-16 text-neutral-500">
              <div className="animate-spin w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              Loading screenshots...
            </div>
          ) : logs.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {logs.map((log) => (
                <motion.div 
                  key={log.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="rounded-xl overflow-hidden border border-neutral-200 bg-white group cursor-pointer shadow-sm hover:shadow-xl hover:border-primary-200 transition-all duration-300"
                  onClick={() => {
                    if (log.screenshot_b64) {
                      const win = window.open();
                      win.document.write(`
                        <html>
                          <head>
                            <title>Screenshot - ${log.app_name} - ${new Date(log.timestamp).toLocaleString()}</title>
                          </head>
                          <body style="margin:0;background:#0f172a;display:flex;justify-content:center;align-items:center;height:100vh;">
                            <img src="data:image/jpeg;base64,${log.screenshot_b64}" style="max-width:98%;max-height:98vh;object-fit:contain;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);border-radius:8px;" />
                          </body>
                        </html>
                      `);
                    }
                  }}
                >
                  <div className="aspect-video bg-neutral-100 flex items-center justify-center overflow-hidden relative">
                    {log.screenshot_b64 ? (
                      <img 
                        src={`data:image/jpeg;base64,${log.screenshot_b64}`} 
                        alt="Screenshot" 
                        loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
                      />
                    ) : (
                      <span className="text-neutral-400">No Image Data</span>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                    <div className="absolute bottom-2 left-2 right-2 flex justify-between items-center transform translate-y-4 group-hover:translate-y-0 transition-transform duration-300">
                      <span className="px-2 py-1 text-[10px] font-bold rounded bg-primary-500 text-white shadow-lg uppercase tracking-wider">
                        {log.app_name}
                      </span>
                    </div>
                  </div>
                  <div className="p-3 bg-white flex justify-between items-center">
                    <div className="flex flex-col">
                      <p className="text-sm font-bold text-neutral-900">
                        {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                      <p className="text-[10px] text-neutral-500 font-medium">
                        {new Date(log.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    <div className="w-8 h-8 rounded-full bg-primary-50 flex items-center justify-center text-primary-600 opacity-0 group-hover:opacity-100 transition-opacity">
                      <ImageIcon size={14} />
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-16 text-neutral-500 bg-neutral-50/50 rounded-xl border border-dashed border-neutral-200">
              <ImageIcon size={48} className="mx-auto text-neutral-300 mb-4 opacity-50" />
              <p className="font-semibold text-neutral-600">No screenshots found</p>
              <p className="text-sm text-neutral-400 mt-1 max-w-xs mx-auto">
                There are no monitoring records for {isAdmin ? 'this employee' : 'you'} during the selected period.
              </p>
            </div>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
};

export default ScreenshotsTab;
