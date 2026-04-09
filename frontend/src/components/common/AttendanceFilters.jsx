import React, { useState, useEffect } from 'react';
import { Filter, Calendar, ChevronDown } from 'lucide-react';
import { Button } from './Button';
import { formatDateLocal } from '../../utils/formatters';

export const AttendanceFilters = ({ onFilterChange, employees = [], excludeCategories = [], showCategory = true }) => {
  const [category, setCategory] = useState('all');
  const [dateRange, setDateRange] = useState('current_month');
  const [selectedUser, setSelectedUser] = useState('all');
  const [customDates, setCustomDates] = useState({
    start: '',
    end: ''
  });

  const categories = [
    { value: 'all', label: 'All Records' },
    { value: 'present', label: 'Present' },
    { value: 'absent', label: 'Absent' },
    { value: 'late', label: 'Late' },
    { value: 'halfday', label: 'Half Day' },
    { value: 'leave', label: 'Leave' },
  ].filter(cat => !excludeCategories.includes(cat.value));

  const handleApply = () => {
    let start = '';
    let end = '';
    const now = new Date();

    if (dateRange === 'current_month') {
      start = formatDateLocal(new Date(now.getFullYear(), now.getMonth(), 1));
      end = formatDateLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (dateRange === 'last_month') {
      start = formatDateLocal(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      end = formatDateLocal(new Date(now.getFullYear(), now.getMonth(), 0));
    } else if (dateRange === 'custom') {
      start = customDates.start;
      end = customDates.end;
    }

    onFilterChange({
      category: showCategory ? category : 'all',
      startDate: start,
      endDate: end,
      userId: selectedUser
    });
  };

  useEffect(() => {
    if (dateRange !== 'custom') {
      handleApply();
    }
  }, [category, dateRange, selectedUser]);

  return (
    <div className="flex flex-wrap items-end gap-6 p-4 bg-neutral-50 rounded-xl border border-neutral-200 mb-6 group">
      {employees.length > 0 && (
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
            Employee
          </label>
          <div className="relative">
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
              className="w-full pl-4 pr-10 py-2.5 bg-white border border-neutral-300 rounded-lg appearance-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all cursor-pointer text-sm"
            >
              <option value="all">All Employees</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" size={16} />
          </div>
        </div>
      )}

      {showCategory && (
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
            Category
          </label>
          <div className="relative">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full pl-4 pr-10 py-2.5 bg-white border border-neutral-300 rounded-lg appearance-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all cursor-pointer text-sm"
            >
              {categories.map(cat => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" size={16} />
          </div>
        </div>
      )}

      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
          Date Range
        </label>
        <div className="relative">
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="w-full pl-4 pr-10 py-2.5 bg-white border border-neutral-300 rounded-lg appearance-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all cursor-pointer text-sm"
          >
            <option value="current_month">Current Month</option>
            <option value="last_month">Last Month</option>
            <option value="custom">Custom Range</option>
          </select>
          <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" size={16} />
        </div>
      </div>

      {dateRange === 'custom' && (
        <>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
              Start Date
            </label>
            <input
              type="date"
              value={customDates.start}
              onChange={(e) => setCustomDates({ ...customDates, start: e.target.value })}
              className="w-full px-4 py-2.5 bg-white border border-neutral-300 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all text-sm"
            />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
              End Date
            </label>
            <input
              type="date"
              value={customDates.end}
              onChange={(e) => setCustomDates({ ...customDates, end: e.target.value })}
              className="w-full px-4 py-2.5 bg-white border border-neutral-300 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all text-sm"
            />
          </div>
          <Button 
            variant="primary" 
            onClick={handleApply}
            className="h-[42px]"
          >
            Apply
          </Button>
        </>
      )}
    </div>
  );
};
