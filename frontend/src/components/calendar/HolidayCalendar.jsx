import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarHeart, Plus, Trash2, Clock, CheckCircle2, Zap, X } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Modal, Input } from '../common';
import api from '../../services/api';

export const HolidayCalendar = ({ isAdmin = false }) => {
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [rangeMode, setRangeMode] = useState(false); // false = single day, true = date range
  const [form, setForm] = useState({ name: '', date: '', startDate: '', endDate: '' });
  const [modalError, setModalError] = useState(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);

  // Process-now state
  const [processing, setProcessing] = useState(false);
  const [processResult, setProcessResult] = useState(null); // { processed, recordsUpdated, leavesRefunded, deductionsRemoved }
  const [processError, setProcessError] = useState(null);

  const pendingCount = holidays.filter(h => h.status === 'pending').length;

  const fetchHolidays = async () => {
    try {
      const res = await api.getHolidays();
      setHolidays(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHolidays();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setModalError(null);
    setModalSubmitting(true);
    try {
      if (rangeMode) {
        const res = await api.createHolidayRange({
          name: form.name,
          startDate: form.startDate,
          endDate: form.endDate
        });
        const { created, total } = res.data;
        if (created < total) {
          setModalError(`${created} of ${total} days created (${total - created} already existed).`);
        } else {
          closeModal();
        }
      } else {
        await api.createHoliday({ name: form.name, date: form.date });
        closeModal();
      }
      fetchHolidays();
    } catch (err) {
      setModalError('Failed to save holiday. Please try again.');
      console.error(err);
    } finally {
      setModalSubmitting(false);
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setRangeMode(false);
    setForm({ name: '', date: '', startDate: '', endDate: '' });
    setModalError(null);
  };

  const handleDelete = async (id) => {
    if (window.confirm('Delete this holiday?')) {
      try {
        await api.deleteHoliday(id);
        fetchHolidays();
      } catch (err) {
        console.error('Failed to delete', err);
      }
    }
  };

  const handleProcessNow = async () => {
    setProcessing(true);
    setProcessResult(null);
    setProcessError(null);
    try {
      const res = await api.processHolidays();
      setProcessResult(res.data);
      fetchHolidays(); // refresh badges
    } catch (err) {
      setProcessError('Failed to process holidays. Please try again.');
      console.error(err);
    } finally {
      setProcessing(false);
    }
  };

  // Group holidays by month
  const groupedHolidays = holidays.reduce((acc, current) => {
    const d = new Date(current.date);
    const month = d.toLocaleString('default', { month: 'long', year: 'numeric' });
    if (!acc[month]) acc[month] = [];
    acc[month].push(current);
    return acc;
  }, {});

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">

      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Holiday Calendar</h2>
          <p className="text-neutral-500 mt-1">Company holidays and non-working days.</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-3">
            <Button
              onClick={handleProcessNow}
              disabled={processing || pendingCount === 0}
              variant="outline"
              className="flex items-center gap-2 border-amber-400 text-amber-700 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Zap size={15} className={processing ? 'animate-pulse' : ''} />
              {processing
                ? 'Processing…'
                : pendingCount > 0
                  ? `Process Now (${pendingCount} pending)`
                  : 'All Marked'}
            </Button>
            <Button onClick={() => setShowModal(true)} className="flex items-center gap-2">
              <Plus size={16} /> Add Holiday
            </Button>
          </div>
        )}
      </div>

      {/* Result / Error banner */}
      <AnimatePresence>
        {processResult && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-start justify-between gap-4 rounded-xl border border-green-200 bg-green-50 px-5 py-4"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="text-green-600 shrink-0" size={20} />
              <div className="text-sm text-green-800">
                <p className="font-semibold">
                  {processResult.processed === 0
                    ? 'No pending holidays found — everything is already up to date.'
                    : `${processResult.processed} holiday(s) marked successfully.`}
                </p>
                {processResult.processed > 0 && (
                  <p className="mt-0.5 text-green-700">
                    {processResult.recordsUpdated} attendance records updated
                    {processResult.leavesRefunded > 0 && ` · ${processResult.leavesRefunded} leaves refunded`}
                    {processResult.deductionsRemoved > 0 && ` · ${processResult.deductionsRemoved} deductions removed`}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={() => setProcessResult(null)}
              className="text-green-500 hover:text-green-700 shrink-0"
            >
              <X size={16} />
            </button>
          </motion.div>
        )}

        {processError && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-5 py-4"
          >
            <p className="text-sm font-medium text-red-700">{processError}</p>
            <button
              onClick={() => setProcessError(null)}
              className="text-red-400 hover:text-red-600 shrink-0"
            >
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Holiday grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <p>Loading...</p>
        ) : holidays.length === 0 ? (
          <p className="col-span-3 text-neutral-500">No holidays specified.</p>
        ) : (
          Object.keys(groupedHolidays).map(month => (
            <Card key={month}>
              <CardHeader className="bg-primary-50 py-3">
                <h3 className="font-bold text-primary-900">{month}</h3>
              </CardHeader>
              <CardBody className="p-0">
                <ul className="divide-y divide-neutral-100">
                  {groupedHolidays[month].map(holiday => (
                    <li key={holiday.id} className="p-4 flex items-center justify-between group w-full">
                      <div className="flex items-center gap-3">
                        <div
                          className={`p-2 rounded-full ${holiday.status === 'marked'
                            ? 'bg-green-100'
                            : 'bg-primary/10'
                            }`}
                        >
                          <CalendarHeart
                            className={`w-5 h-5 ${holiday.status === 'marked'
                              ? 'text-green-600'
                              : 'text-primary'
                              }`}
                          />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 justify-between w-full">
                            <div className="flex-1">
                              <p className="font-semibold text-neutral-900 tracking-[1px] font-poppins">{holiday.name?.toUpperCase()}  <span className="text-xs text-neutral-500 ml-2">
                                | {new Date(holiday.date).toLocaleDateString(undefined, {
                                  weekday: 'short', month: 'short', day: 'numeric'
                                })}
                              </span></p>
                            </div>
                            <div>
                            </div>
                          </div>
                        </div>
                      </div>
                      {isAdmin && (
                        <button
                          onClick={() => handleDelete(holiday.id)}
                          className="opacity-0 group-hover:opacity-100 p-2 text-neutral-400 hover:text-red-600 transition-opacity"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))
        )}
      </div>

      {/* Add Holiday Modal */}
      {showModal && (
        <Modal isOpen={true} title="Add Holiday" onClose={closeModal}>
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Mode toggle */}
            <div className="flex items-center gap-1 p-1 bg-neutral-100 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setRangeMode(false)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${!rangeMode ? 'bg-white shadow text-neutral-900' : 'text-neutral-500 hover:text-neutral-700'
                  }`}
              >
                Single Day
              </button>
              <button
                type="button"
                onClick={() => setRangeMode(true)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${rangeMode ? 'bg-white shadow text-neutral-900' : 'text-neutral-500 hover:text-neutral-700'
                  }`}
              >
                Date Range
              </button>
            </div>

            {/* Name */}
            <Input
              label="Holiday Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={rangeMode ? 'e.g. Eid Holidays' : 'e.g. Independence Day'}
              required
            />

            {/* Date fields */}
            {rangeMode ? (
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Start Date"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  required
                />
                <Input
                  label="End Date"
                  type="date"
                  value={form.endDate}
                  min={form.startDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  required
                />
              </div>
            ) : (
              <Input
                label="Date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                required
              />
            )}

            {/* Day count preview for range mode */}
            {rangeMode && form.startDate && form.endDate && new Date(form.endDate) >= new Date(form.startDate) && (() => {
              const start = new Date(form.startDate);
              const end = new Date(form.endDate);
              const days = Math.round((end - start) / 86400000) + 1;
              return (
                <p className="text-sm text-primary-600 font-medium">
                  ✦ {days} day{days !== 1 ? 's' : ''} will be created as holidays
                </p>
              );
            })()}

            {/* Inline error */}
            {modalError && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {modalError}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={closeModal}>Cancel</Button>
              <Button type="submit" disabled={modalSubmitting}>
                {modalSubmitting ? 'Saving…' : rangeMode ? 'Create Holidays' : 'Save'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </motion.div>
  );
};
