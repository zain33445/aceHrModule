import React, { useState, useEffect, useCallback } from "react";
import { SlideUp } from "../animations";
import { Card, CardHeader, CardBody } from "../common/Card";
import { PayslipPDFButton } from "./PayslipPDFButton";
import api from "../../services/api";
import { formatDateLocal } from "../../utils/formatters";

export const PayrollTab = ({ report: propReport, loading: propLoading, onMonthChange, onFetch }) => {
  const [localReport, setLocalReport] = useState([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [bulkPayDate, setBulkPayDate] = useState(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
  const [bulkPayLoading, setBulkPayLoading] = useState(false);
  const [bulkPayMessage, setBulkPayMessage] = useState("");
  const [prevMonth, setPrevMonth] = useState("");
  const [preMonthLoading, setPreMonthLoading] = useState(false);

  const isControlled = propReport !== undefined;

  const fetchReport = useCallback(async (monthStr) => {
    setLocalLoading(true);
    try {
      const [year, m] = monthStr.split("-").map(Number);
      const start = formatDateLocal(new Date(year, m - 1, 1));
      const end = formatDateLocal(new Date(year, m, 0));
      const res = await api.getSalaryReport(start, end);
      setLocalReport(res.data || []);
    } catch (err) {
      console.error("Failed to fetch payroll report:", err);
    } finally {
      setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isControlled && !prevMonth) {
      const date = new Date();
      const defaultMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      fetchReport(defaultMonth);
    }
  }, [isControlled, prevMonth, fetchReport]);

  const report = isControlled ? propReport : localReport;
  const loading = isControlled ? propLoading : localLoading;

  const handleMonthChange = (val) => {
    setBulkPayDate(val);
    if (onMonthChange) onMonthChange(val);
  };

  const handleSpecificMonthPay = (monthStr) => {
    setPrevMonth(monthStr);
    if (isControlled && onFetch) {
      const [year, m] = monthStr.split("-").map(Number);
      onFetch({ start: formatDateLocal(new Date(year, m - 1, 1)), end: formatDateLocal(new Date(year, m, 0)) });
    } else {
      fetchReport(monthStr);
    }
  };

  const handleBulkPay = async () => {
    if (!bulkPayDate) {
      alert("Please select a month first");
      return;
    }
    if (!window.confirm(`Process salary payments for ${new Date(bulkPayDate).toLocaleString("default", { month: "long", year: "numeric" })}?`))
      return;
    setBulkPayLoading(true);
    setBulkPayMessage("");
    try {
      const res = await api.processBulkSalary(bulkPayDate);
      setBulkPayMessage(res.data?.message || "Salaries processed successfully");
    } catch (err) {
      setBulkPayMessage("Failed to process bulk salary");
    } finally {
      setBulkPayLoading(false);
    }
  };

  return (
    <SlideUp>
      <div className="flex gap-3 mb-6 w-1/2 m-auto">
        <div className="flex-1">
          <div className="flex items-center gap-3 bg-white border border-gray-400 rounded-lg px-4 py-3">
            <span className="text-xs text-neutral-400 whitespace-nowrap">Previous month</span>
            <div className="w-px h-6 bg-neutral-100 shrink-0" />
            <input
              type="month"
              value={prevMonth}
              onChange={(e) => handleSpecificMonthPay(e.target.value)}
              className="flex-1 min-w-0 text-sm text-neutral-800 bg-transparent border-none outline-none cursor-pointer"
            />
          </div>
        </div>
        <div className="flex-1 flex flex-col gap-1">
          <div className="flex items-center gap-3 bg-white border border-gray-400 rounded-lg px-4 py-3">
            <span className="text-xs text-neutral-400 whitespace-nowrap">Process salaries</span>
            <div className="w-px h-6 bg-neutral-100 shrink-0" />
            <input
              type="month"
              value={bulkPayDate}
              onChange={(e) => handleMonthChange(e.target.value)}
              className="flex-1 min-w-0 text-sm text-neutral-800 bg-transparent border-none outline-none cursor-pointer"
            />
            <button
              onClick={handleBulkPay}
              disabled={bulkPayLoading || !bulkPayDate}
              className="text-xs text-neutral-500 bg-neutral-100 border border-neutral-200 rounded-lg px-3 py-1 whitespace-nowrap hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {bulkPayLoading ? "Running\u2026" : "Run"}
            </button>
          </div>
          {bulkPayMessage && (
            <p className={`text-xs pl-1 ${bulkPayMessage.includes("Failed") ? "text-red-500" : "text-green-600"}`}>
              {bulkPayMessage}
            </p>
          )}
        </div>
      </div>
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">Payroll Summary</h3>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Base Salary</th>
                    <th>Deductions</th>
                    <th>Leaves Used</th>
                    <th>Net Payable</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(report || []).slice(0, 20).map((emp) => (
                    <tr key={emp.id}>
                      <td>
                        <p className="font-medium">{emp.name}</p>
                        <p className="text-xs text-neutral-600">ID: {emp.id}</p>
                      </td>
                      <td>PKR {emp.monthly_salary?.toLocaleString()}</td>
                      <td className="text-error">PKR {emp.deductions?.toLocaleString()}</td>
                      <td>{emp.paid_leaves_used} days</td>
                      <td className="font-bold text-primary-600">PKR {emp.total_salary?.toLocaleString()}</td>
                      <td>
                        <PayslipPDFButton
                          employeeName={emp.name}
                          salaryData={{
                            userId: emp.id,
                            monthly_salary: emp.monthly_salary,
                            deductions: emp.deductions,
                            paid_leaves_used: emp.paid_leaves_used,
                            total_salary: emp.total_salary,
                            date: new Date(),
                          }}
                        />
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

export default PayrollTab;
