import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarHeart, Plus, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Modal, Input } from '../common';
import api from '../../services/api';

export const HolidayCalendar = ({ isAdmin = false }) => {
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', date: '' });

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
    try {
      await api.createHoliday(form);
      setShowModal(false);
      setForm({ name: '', date: '' });
      fetchHolidays();
    } catch (err) {
      console.error('Failed to create holiday', err);
    }
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
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Holiday Calendar</h2>
          <p className="text-neutral-500 mt-1">Company holidays and non-working days.</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setShowModal(true)} className="flex items-center gap-2">
            <Plus size={16} /> Add Holiday
          </Button>
        )}
      </div>

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
                    <li key={holiday.id} className="p-4 flex items-center justify-between group">
                      <div className="flex items-center gap-3">
                        <div className="bg-primary-100 p-2 rounded-full">
                          <CalendarHeart className="w-5 h-5 text-primary-600" />
                        </div>
                        <div>
                          <p className="font-semibold text-neutral-900">{holiday.name}</p>
                          <p className="text-sm text-neutral-500">
                            {new Date(holiday.date).toLocaleDateString(undefined, {
                              weekday: 'short', month: 'short', day: 'numeric'
                            })}
                          </p>
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

      {showModal && (
        <Modal isOpen={true} title="Add Holiday" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Holiday Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
              <Input
                label="Date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                required
              />
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Modal>
      )}
    </motion.div>
  );
};
