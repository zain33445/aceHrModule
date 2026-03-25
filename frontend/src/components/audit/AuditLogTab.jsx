import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Activity, Search } from 'lucide-react';
import { Card, CardBody } from '../common/Card';
import { Pagination } from '../common/Pagination';
import api from '../../services/api';

export const AuditLogTab = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ currentPage: 1, totalPages: 1 });

  const fetchLogs = async (page = 1) => {
    setLoading(true);
    try {
      const res = await api.getAuditLogs(page, 50);
      setLogs(res.data.logs);
      setPagination({
        currentPage: res.data.pagination.page,
        totalPages: res.data.pagination.totalPages
      });
    } catch (err) {
      console.error('Failed to fetch audit logs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Audit Logs</h2>
        <p className="text-neutral-500 mt-1">Review system activities and admin operations.</p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-neutral-50 text-neutral-500 border-b border-neutral-200">
              <tr>
                <th className="px-6 py-4 font-medium">Timestamp</th>
                <th className="px-6 py-4 font-medium">Action</th>
                <th className="px-6 py-4 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center text-neutral-500">Loading...</td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center text-neutral-500">No activity recorded</td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-neutral-50/50 transition-colors">
                    <td className="px-6 py-4">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium 
                        ${log.action.includes('DELETE') ? 'bg-red-100 text-red-700' :
                        log.action.includes('POST') ? 'bg-green-100 text-green-700' :
                        log.action.includes('PUT') ? 'bg-blue-100 text-blue-700' : 'bg-neutral-100 text-neutral-700'}
                      `}>
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-neutral-600 truncate max-w-xs">
                      {log.details || '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && logs.length > 0 && (
          <div className="border-t border-neutral-200 p-4">
            <Pagination
              currentPage={pagination.currentPage}
              totalPages={pagination.totalPages}
              onPageChange={fetchLogs}
            />
          </div>
        )}
      </Card>
    </motion.div>
  );
};
