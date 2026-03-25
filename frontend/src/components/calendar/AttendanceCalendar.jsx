import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';

// Utility to get calendar grid days
const getDaysInMonth = (year, month) => {
  const date = new Date(year, month, 1);
  const days = [];
  while (date.getMonth() === month) {
    days.push(new Date(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
};

export const AttendanceCalendar = ({ logs = [], holidays = [], absences = [] }) => {
  const [currentDate, setCurrentDate] = useState(new Date());

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const daysInMonth = getDaysInMonth(year, month);
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  
  // Pad the grid to start on respective weekday
  const paddingDays = Array.from({ length: firstDayOfMonth }, (_, i) => null);

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  // Build a fast lookup map for statuses
  // We'll prioritize: Holiday -> Leave -> Absent -> Late -> Present
  const dateStatusMap = {};
  
  // map logs (late, present, halfday)
  (logs || []).forEach(log => {
    const d = new Date(log.timestamp).toISOString().split('T')[0];
    dateStatusMap[d] = log.status || 'present';
  });

  // map absences (absent, leave)
  (absences || []).forEach(abs => {
    const d = new Date(abs.date).toISOString().split('T')[0];
    dateStatusMap[d] = abs.category === 'leave' ? 'leave' : 'absent';
  });

  // map holidays
  (holidays || []).forEach(hol => {
    const d = new Date(hol.date).toISOString().split('T')[0];
    dateStatusMap[d] = 'holiday';
  });

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'present': return 'bg-green-100 text-green-700 border-green-200';
      case 'late': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'halfday': return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'absent': return 'bg-red-100 text-red-700 border-red-200';
      case 'leave': return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'holiday': return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-neutral-50 text-neutral-400 border-neutral-100';
    }
  };

  const getStatusLabel = (status) => {
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : '-';
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <Card>
        <CardHeader className="flex items-center justify-between border-b border-neutral-100 pb-4">
          <h3 className="text-xl font-bold text-neutral-900 flex items-center gap-4">
            <Button variant="ghost" onClick={prevMonth} className="px-2"><ChevronLeft size={20} /></Button>
            {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
            <Button variant="ghost" onClick={nextMonth} className="px-2"><ChevronRight size={20} /></Button>
          </h3>
          <div className="hidden sm:flex items-center gap-3 text-sm">
            <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-400"></span> Present</div>
            <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-400"></span> Absent</div>
            <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-yellow-400"></span> Late</div>
            <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-blue-400"></span> Holiday</div>
            <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-purple-400"></span> Leave</div>
          </div>
        </CardHeader>
        <CardBody className="p-6">
          <div className="grid grid-cols-7 gap-2 mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <div key={day} className="text-center text-sm font-semibold text-neutral-500 py-2">
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-2">
            {paddingDays.map((_, i) => (
              <div key={`pad-${i}`} className="aspect-square rounded-xl bg-neutral-50/50"></div>
            ))}
            {daysInMonth.map((day) => {
              const dateStr = day.toISOString().split('T')[0];
              const isToday = new Date().toISOString().split('T')[0] === dateStr;
              const status = dateStatusMap[dateStr];
              
              return (
                <div 
                  key={dateStr}
                  className={`aspect-square p-2 border rounded-xl flex flex-col items-center justify-center transition-all
                    ${getStatusColor(status)}
                    ${isToday ? 'ring-2 ring-primary-500 ring-offset-2' : ''}
                    hover:shadow-md cursor-default
                  `}
                >
                  <span className={`text-lg font-bold ${!status ? 'opacity-50' : ''}`}>{day.getDate()}</span>
                  <span className="text-[10px] hidden sm:block font-medium uppercase mt-1 tracking-wider opacity-80">
                    {getStatusLabel(status)}
                  </span>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
};
