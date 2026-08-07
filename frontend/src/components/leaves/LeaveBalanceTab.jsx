import React, { useState, useEffect, useCallback } from "react";
import { CalendarCheck, Filter } from "lucide-react";
import { Card, CardHeader, CardBody } from "../common/Card";
import { SlideUp } from "../animations";
import api from "../../services/api";

export const LeaveBalanceTab = () => {
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [loading, setLoading] = useState(false);

  const fetchSummary = useCallback(async (dept) => {
    setLoading(true);
    try {
      const res = await api.getLeaveSummary(dept);
      setLeaveTypes(res.data?.leaveTypes || []);
      setEmployees(res.data?.employees || []);
      const deptMap = new Map();
      (res.data?.employees || []).forEach((e) => {
        if (e.department_id) deptMap.set(e.department_id, e.department);
      });
      setDepartments(
        Array.from(deptMap, ([id, name]) => ({ id, name })).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
    } catch (err) {
      console.error("Failed to fetch leave summary:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary("all");
  }, [fetchSummary]);

  const handleDeptChange = (e) => {
    const value = e.target.value;
    setDepartmentFilter(value);
    fetchSummary(value);
  };

  return (
    <SlideUp>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex items-center gap-2 bg-white border border-neutral-400 rounded-lg px-4 py-3">
          <Filter size={14} className="text-neutral-400" />
          <select
            value={departmentFilter}
            onChange={handleDeptChange}
            className="text-sm text-neutral-800 bg-transparent outline-none cursor-pointer"
          >
            <option value="all">All Departments</option>
            {departments.map((dept) => (
              <option key={dept.id} value={dept.id}>
                {dept.name}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-neutral-500">
          {employees.length} employee(s)
        </span>
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">
            Leave Balance Summary
          </h3>
          <span className="text-sm text-neutral-500">
            Remaining, Used &amp; Accrual Rate per type
          </span>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : employees.length === 0 ? (
            <div className="text-center py-12 text-neutral-400">
              <CalendarCheck size={40} className="mx-auto mb-3 opacity-40" />
              <p>No employees found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="text-left sticky left-0 bg-neutral-50 z-10">
                      Employee
                    </th>
                    <th className="text-left">Department</th>
                    {leaveTypes.map((type) => (
                      <th
                        key={type.id}
                        colSpan={3}
                        className="text-center border-l border-neutral-200"
                      >
                        {type.name}
                      </th>
                    ))}
                    <th className="text-center border-l border-neutral-200">
                      Total
                    </th>
                  </tr>
                  <tr>
                    <th className="sticky left-0 bg-neutral-50 z-10"></th>
                    <th></th>
                    {leaveTypes.map((type) => (
                      <React.Fragment key={`cols-${type.id}`}>
                        <th className="text-center">Remaining</th>
                        <th className="text-center">Used</th>
                        <th className="text-center">Accrual</th>
                      </React.Fragment>
                    ))}
                    <th className="text-center border-l border-neutral-200">
                      Remaining
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => (
                    <tr key={emp.id}>
                      <td className="font-medium sticky left-0 bg-white z-10">
                        {emp.name}
                      </td>
                      <td className="text-xs text-neutral-500">
                        {emp.department || "-"}
                      </td>
                      {emp.types.map((t) => (
                        <React.Fragment key={`${emp.id}-${t.leave_type_id}`}>
                          <td className="text-center">{t.remaining}</td>
                          <td className="text-center">
                            {t.used > 0 ? t.used : "-"}
                          </td>
                          <td className="text-center">
                            {t.accrual_rate > 0 ? t.accrual_rate : "-"}
                          </td>
                        </React.Fragment>
                      ))}
                      <td className="text-center font-medium border-l border-neutral-200">
                        {emp.totals.remaining}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
};

export default LeaveBalanceTab;