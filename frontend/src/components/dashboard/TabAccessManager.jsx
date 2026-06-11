import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, Loader2, Search } from "lucide-react";
import { Card, CardHeader, CardBody } from "../common/Card";
import api from "../../services/api";

const ALL_TABS = [
  { key: "overview", label: "Analytics" },
  { key: "attendance", label: "Attendance" },
  { key: "payroll", label: "Payroll" },
  { key: "leaves", label: "Leave Requests" },
  { key: "leave-allocation", label: "Leave Allocation" },
  { key: "disputes", label: "Appeals" },
  { key: "departments", label: "Departments" },
  { key: "screenshots", label: "Screenshots" },
  { key: "employees", label: "Staff" },
  { key: "recording", label: "Recording" },
  { key: "holidays", label: "Holidays" },
  { key: "export", label: "Export" },
  { key: "overtime", label: "Overtime" },
  { key: "audit", label: "Audit Logs" },
  { key: "settings", label: "Settings" },
];

export const TabAccessManager = () => {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [toggling, setToggling] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.getHrEmployeesWithTabs();
      setEmployees(res.data.employees || []);
    } catch (err) {
      console.error("Failed to fetch HR employees:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleTab = (userId, tabKey, newGranted, prevEmployees) =>
    prevEmployees.map((emp) => {
      if (emp.id !== userId) return emp;
      const tabs = new Set(emp.granted_tabs);
      if (newGranted) {
        tabs.add(tabKey);
      } else {
        tabs.delete(tabKey);
      }
      return { ...emp, granted_tabs: Array.from(tabs) };
    });

  const handleToggle = async (userId, tabKey, granted) => {
    const newGranted = !granted;
    setToggling(`${userId}-${tabKey}`);
    try {
      const res = await api.toggleTabAccess(userId, tabKey, newGranted);
      setEmployees((prev) => toggleTab(userId, tabKey, newGranted, prev));

      // Auto-grant export when attendance or payroll is checked
      if (newGranted && (tabKey === "attendance" || tabKey === "payroll")) {
        setEmployees((prev) => toggleTab(userId, "export", true, prev));
      }
    } catch (err) {
      console.error("Failed to toggle tab access:", err);
    } finally {
      setToggling(null);
    }
  };

  const filteredEmployees = employees.filter((emp) =>
    emp.name?.toLowerCase().includes(search.toLowerCase()) ||
    emp.username?.toLowerCase().includes(search.toLowerCase()) ||
    emp.email?.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-neutral-900">Feature Access</h2>
          <p className="text-neutral-500 mt-1">
            Grant or revoke admin panel tab access for HR department employees
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input
            type="text"
            placeholder="Search employees..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-4 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
      </div>

      {filteredEmployees.length === 0 ? (
        <Card>
          <CardBody>
            <div className="text-center py-12 text-neutral-500">
              <ShieldCheck className="w-12 h-12 mx-auto mb-3 text-neutral-300" />
              <p className="font-medium">No HR employees found</p>
              <p className="text-sm mt-1">
                Ensure there is a department named "HR" with employees assigned to it
              </p>
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-200">
                <th className="text-left py-3 px-4 text-sm font-semibold text-neutral-600 w-64">Employee</th>
                {ALL_TABS.map((tab) => (
                  <th key={tab.key} className="text-center py-3 px-2 text-xs font-semibold text-neutral-500 min-w-[90px]">
                    {tab.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredEmployees.map((emp) => (
                <tr
                  key={emp.id}
                  className="border-b border-neutral-100 hover:bg-neutral-50 transition-colors"
                >
                  <td className="py-3 px-4">
                    <div className="flex flex-col">
                      <span className="font-medium text-sm text-neutral-900">{emp.name}</span>
                      <span className="text-xs text-neutral-400">
                        {emp.username || emp.email || emp.id}
                      </span>
                    </div>
                  </td>
                  {ALL_TABS.map((tab) => {
                    const granted = emp.granted_tabs?.includes(tab.key);
                    const isToggling = toggling === `${emp.id}-${tab.key}`;

                    return (
                      <td key={tab.key} className="text-center py-3 px-2">
                        <motion.button
                          whileTap={{ scale: 0.9 }}
                          disabled={isToggling}
                          onClick={() => handleToggle(emp.id, tab.key, granted)}
                          className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-all mx-auto ${
                            granted
                              ? "bg-primary-500 border-primary-500 text-white"
                              : "border-neutral-300 hover:border-primary-400"
                          } ${isToggling ? "opacity-50" : ""}`}
                        >
                          {isToggling ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : granted ? (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : null}
                        </motion.button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TabAccessManager;
