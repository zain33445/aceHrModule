import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Plus, Check, AlertCircle, X } from 'lucide-react';
import { Card, CardHeader, CardBody, CardFooter } from '../common/Card';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { SlideUp } from '../animations';
import api from '../../services/api';

export function LeaveAllocationTab({ employees = [], user }) {
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [employeesWithDepts, setEmployeesWithDepts] = useState(employees);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [applyLoading, setApplyLoading] = useState(false);

  // Form state
  const [allocationMode, setAllocationMode] = useState('single'); // 'single', 'multiple', 'all', 'department'
  const [selectedEmployees, setSelectedEmployees] = useState([]); // For single/multiple selection
  const [selectedDepartment, setSelectedDepartment] = useState('');
  const [selectedLeaveType, setSelectedLeaveType] = useState('');
  const [accrualRate, setAccrualRate] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().split('T')[0]);

  const [createdPolicies, setCreatedPolicies] = useState([]);

  useEffect(() => {
    fetchLeaveTypes();
    // Fetch employees with department info
    if (employees && employees.length > 0) {
      fetchEmployeesWithDepartments();
    }
  }, [employees]);

  const fetchEmployeesWithDepartments = async () => {
    try {
      const res = await api.getEmployees();
      setEmployeesWithDepts(res.data || employees);
    } catch (err) {
      console.warn('Failed to fetch employees with departments, using provided data:', err);
      setEmployeesWithDepts(employees);
    }
  };

  // Get unique departments
  const departments = [...new Set(
    employeesWithDepts
      .map((emp) => emp.department?.name)
      .filter(Boolean)
  )].sort();
  
  // Get employees for selected department
  const departmentEmployees = selectedDepartment
    ? employeesWithDepts.filter((emp) => emp.department?.name === selectedDepartment)
    : [];

  const fetchLeaveTypes = async () => {
    setLoading(true);
    try {
      const res = await api.getLeaveTypes();
      setLeaveTypes(res.data || []);
    } catch (err) {
      console.error('Failed to fetch leave types:', err);
      setErrorMessage('Failed to load leave types');
    }
    setLoading(false);
  };

  const validateForm = () => {
    if (!selectedLeaveType) {
      setErrorMessage('Please select a leave type');
      return false;
    }
    if (!accrualRate || parseFloat(accrualRate) < 0) {
      setErrorMessage('Please enter a valid accrual rate');
      return false;
    }
    if (allocationMode === 'single' && selectedEmployees.length === 0) {
      setErrorMessage('Please select at least one employee');
      return false;
    }
    if (allocationMode === 'department' && !selectedDepartment) {
      setErrorMessage('Please select a department');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateForm()) return;

    setSubmitting(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      let employeeIds = [];

      if (allocationMode === 'all') {
        employeeIds = employeesWithDepts.map((emp) => emp.id || emp.user_id);
      } else if (allocationMode === 'single') {
        employeeIds = selectedEmployees;
      } else if (allocationMode === 'department') {
        employeeIds = departmentEmployees.map((emp) => emp.id || emp.user_id);
      }

      const payload = {
        employee_ids: employeeIds,
        leave_type_id: parseInt(selectedLeaveType),
        accrual_rate: parseFloat(accrualRate),
        change_reason: changeReason || 'Leave allocation',
        updated_by: user?.user_id || user?.id,
        effective_from: effectiveFrom,
      };

      const res = await api.createLeavePoliciesBulk(payload);
      setCreatedPolicies(res.data || []);
      setSuccessMessage(
        `Successfully created/updated ${res.data?.length || 0} leave policies`
      );

      // Reset form
      setSelectedEmployees([]);
      setSelectedDepartment('');
      setSelectedLeaveType('');
      setAccrualRate('');
      setChangeReason('');
      setEffectiveFrom(new Date().toISOString().split('T')[0]);
    } catch (err) {
      console.error('Failed to create policies:', err);
      setErrorMessage(
        err.response?.data?.error || 'Failed to create leave policies'
      );
    }
    setSubmitting(false);
  };

  const handleApplyPoliciesNow = async () => {
    setApplyLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const res = await api.applyActivePolicies();
      setSuccessMessage(res.data?.message || 'Active leave policies applied immediately');
    } catch (err) {
      console.error('Failed to apply active policies:', err);
      setErrorMessage(err.response?.data?.error || 'Failed to apply active policies');
    }

    setApplyLoading(false);
  };

  const employeeCount = (dept) => {
    return employeesWithDepts.filter((emp) => emp.department?.name === dept).length;
  };

  return (
    <SlideUp>
      <div className="space-y-6">
        {/* Form Card */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
              <Plus size={20} />
              Add Leave Allocation
            </h3>
            <p className="text-sm text-neutral-500 mt-1">
              Create or update leave policies for employees
            </p>
          </CardHeader>
          <CardBody>
            <form onSubmit={handleSubmit} className="space-y-6 flex flex-wrap gap-6 justify-around">


              {/* Employee Selection */}
              <div className="bg-neutral-50 p-4 rounded-lg border border-neutral-200 w-1/2">

                <label className="text-sm font-semibold text-neutral-700 mb-3 block">
                  Employee Selection
                </label>
                <div className="space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="single"
                      checked={allocationMode === 'single'}
                      onChange={(e) => {
                        setAllocationMode(e.target.value);
                        setSelectedEmployees([]);
                        setSelectedDepartment('');
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-neutral-700">Single/Multiple Employees</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="all"
                      checked={allocationMode === 'all'}
                      onChange={(e) => {
                        setAllocationMode(e.target.value);
                        setSelectedEmployees([]);
                        setSelectedDepartment('');
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-neutral-700">All Employees</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="department"
                      checked={allocationMode === 'department'}
                      onChange={(e) => {
                        setAllocationMode(e.target.value);
                        setSelectedEmployees([]);
                        setSelectedDepartment('');
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-neutral-700">Department-wise</span>
                  </label>
                </div>

                {/* Single/Multiple Employees */}
                {allocationMode === 'single' && (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs text-neutral-600 mb-2">Select one or more employees:</p>
                    <div className="max-h-64 overflow-y-auto border border-neutral-300 rounded-lg bg-white p-3">
                      {employeesWithDepts.map((emp) => (
                        <label key={emp.id || emp.user_id} className="flex items-center gap-2 py-2 px-2 hover:bg-neutral-100 rounded cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedEmployees.includes(emp.id || emp.user_id)}
                            onChange={(e) => {
                              const empId = emp.id || emp.user_id;
                              if (e.target.checked) {
                                setSelectedEmployees([...selectedEmployees, empId]);
                              } else {
                                setSelectedEmployees(selectedEmployees.filter((id) => id !== empId));
                              }
                            }}
                            className="w-4 h-4"
                          />
                          <span className="text-sm text-neutral-700">{emp.name}</span>
                          {emp.department?.name && (
                            <span className="text-xs text-neutral-500 ml-auto">({emp.department.name})</span>
                          )}
                        </label>
                      ))}
                    </div>
                    {selectedEmployees.length > 0 && (
                      <p className="text-xs text-green-600 mt-2">
                        {selectedEmployees.length} employee(s) selected
                      </p>
                    )}
                  </div>
                )}

                {/* Department Selection */}
                {allocationMode === 'department' && (
                  <div className="mt-4">
                    <select
                      value={selectedDepartment}
                      onChange={(e) => setSelectedDepartment(e.target.value)}
                      className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-neutral-900 bg-white"
                    >
                      <option value="">Select a department</option>
                      {departments.map((dept) => (
                        <option key={dept} value={dept}>
                          {dept} ({employeeCount(dept)} employees)
                        </option>
                      ))}
                    </select>
                    {selectedDepartment && (
                      <p className="text-xs text-green-600 mt-2">
                        {departmentEmployees.length} employees in {selectedDepartment} department
                      </p>
                    )}
                  </div>
                )}

                {allocationMode === 'all' && (
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-blue-700">
                      Leave allocation will be applied to all {employeesWithDepts.length} employees
                    </p>
                  </div>
                )}
              </div>
<div className='flex flex-row gap-1 justify-center align-center w-1/3 flex-wrap'>

    



              {/* Leave Type */}
              <div className='w-2/3'>
                <label className="text-sm font-semibold text-neutral-700 mb-2 block">
                  Leave Type <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedLeaveType}
                  onChange={(e) => setSelectedLeaveType(e.target.value)}
                  className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-neutral-900 bg-white"
                >
                  <option value="">Select a leave type</option>
                  {leaveTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name} {type.is_paid ? '(Paid)' : '(Unpaid)'}
                    </option>
                  ))}
                </select>
              </div>

              {/* Effective From Date */}
              <div className='w-2/3'>
                <label className="text-sm font-semibold text-neutral-700 mb-2 block">
                  Effective From
                </label>
                <input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-neutral-900"
                />
              </div>
              {/* Accrual Rate */}
              <div className='w-2/3'>
                <label className="text-sm font-semibold text-neutral-700 mb-2 block">
                  Accrual Rate <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={accrualRate}
                  onChange={(e) => setAccrualRate(e.target.value)}
                  placeholder="e.g., 1.5"
                  className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-neutral-900"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  Number of leaves accrued per month
                </p>
              </div>
              {/* Change Reason */}
              <div  className='m-auto w-full '>
                <label className="text-sm font-semibold text-neutral-700 mb-2 block">
                  Change Reason
                </label>
                <textarea
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                  placeholder="Optional: Reason for this allocation"
                  rows="3"
                  className="w-full px-4 py-2 border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-neutral-900"
                />
              </div>
</div>

              {/* Messages */}
              {successMessage && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-lg text-green-700"
                >
                  <Check size={18} />
                  <span className="text-sm">{successMessage}</span>
                  <button
                    type="button"
                    onClick={() => setSuccessMessage('')}
                    className="ml-auto"
                  >
                    <X size={16} />
                  </button>
                </motion.div>
              )}

              {errorMessage && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700"
                >
                  <AlertCircle size={18} />
                  <span className="text-sm">{errorMessage}</span>
                  <button
                    type="button"
                    onClick={() => setErrorMessage('')}
                    className="ml-auto"
                  >
                    <X size={16} />
                  </button>
                </motion.div>
              )}
            </form>
          </CardBody>
          <CardFooter className="flex gap-3 justify-end">
            <Button
              variant="secondary"
              onClick={() => {
                setAllocationMode('single');
                setSelectedEmployees([]);
                setSelectedDepartment('');
                setSelectedLeaveType('');
                setAccrualRate('');
                setChangeReason('');
                setEffectiveFrom(new Date().toISOString().split('T')[0]);
                setSuccessMessage('');
                setErrorMessage('');
              }}
            >
              Clear
            </Button>
            <Button
              variant="secondary"
              onClick={handleApplyPoliciesNow}
              disabled={applyLoading || submitting || loading}
            >
              {applyLoading ? 'Applying...' : 'Apply Policies Now'}
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={submitting || loading}
            >
              {submitting ? 'Creating...' : 'Create Allocation'}
            </Button>
          </CardFooter>
        </Card>

        {/* Created Policies Summary */}
        {createdPolicies.length > 0 && (
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
                <Check size={20} className="text-green-600" />
                Created/Updated Policies
              </h3>
            </CardHeader>
            <CardBody className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">
                        Employee
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">
                        Leave Type
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">
                        Accrual Rate
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">
                        Effective From
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {createdPolicies.map((policy, idx) => (
                      <tr key={idx} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-4 text-sm text-neutral-900">
                          {policy.user?.name || policy.user_id}
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-900">
                          {policy.leave_type?.name || policy.leave_type_id}
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-900 font-mono">
                          {parseFloat(policy.accrual_rate).toFixed(2)}
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-900">
                          {new Date(policy.effective_from).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant="success">Active</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </SlideUp>
  );
}
