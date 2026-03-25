import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Download, FileDown, Calendar, DollarSign } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import api from '../../services/api';

export const DataExportPanel = () => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const handleExportAttendance = () => {
    window.open(api.getExportAttendanceUrl(startDate, endDate), '_blank');
  };

  const handleExportSalary = () => {
    window.open(api.getExportSalaryUrl(startDate, endDate), '_blank');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Data Export</h2>
          <p className="text-neutral-500 mt-1">Download system records in Excel format.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">Export Filters</h3>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              />
            </div>
          </div>
          <p className="text-sm text-neutral-500">Leaving dates empty will export all available records.</p>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardBody className="flex flex-col items-center p-8 text-center">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
              <Calendar className="w-8 h-8 text-blue-600" />
            </div>
            <h3 className="text-lg font-bold text-neutral-900 mb-2">Attendance Log</h3>
            <p className="text-sm text-neutral-500 mb-6">Export detailed daily check-in and check-out logs for all employees.</p>
            <Button
              onClick={handleExportAttendance}
              className="w-full flex items-center justify-center gap-2"
              variant="primary"
            >
              <FileDown className="w-4 h-4" />
              Download Excel
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col items-center p-8 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <DollarSign className="w-8 h-8 text-green-600" />
            </div>
            <h3 className="text-lg font-bold text-neutral-900 mb-2">Salary History</h3>
            <p className="text-sm text-neutral-500 mb-6">Export monthly salary calculations, deductions, and total paid amounts.</p>
            <Button
              onClick={handleExportSalary}
              className="w-full flex items-center justify-center gap-2"
              variant="primary"
            >
              <FileDown className="w-4 h-4" />
              Download Excel
            </Button>
          </CardBody>
        </Card>
      </div>
    </motion.div>
  );
};
