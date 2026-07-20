import React, { useState, useEffect } from "react";
import {
  Trash2,
  UserPlus,
  AlertCircle,
  Eye,
  EyeOff,
  ChevronRight,
} from "lucide-react";
import { Select, Modal } from "./common";
import api from "../services/api";

function StaffManager({
  employees,
  onUpdate,
  onShowHistory,
  onUpdatePassword,
  onRefresh,
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [newEmp, setNewEmp] = useState({
    id: "",
    username: "",
    name: "",
    monthly_salary: 0,
    password: "1234",
    role: "employee",
    department_id: "",
    status: "active",
    type: "probation",
    joining_date: "",
    dob: "",
    closing_date: "",
    probation_duration: "",
  });
  const [departments, setDepartments] = useState([]);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [editedValues, setEditedValues] = useState({});
  const [ribbon, setRibbon] = useState({ type: "", text: "", show: false });

  useEffect(() => {
    fetchDepartments();
  }, []);

  const fetchDepartments = async () => {
    try {
      const res = await api.getDepartments();
      setDepartments(res.data || []);
    } catch (err) {
      console.error("Failed to fetch departments", err);
    }
  };

  const sortedEmployees = [...employees].sort((a, b) => b.id - a.id);

  const handleEdit = (id, field, value) => {
    setEditedValues((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }));
  };

  const handleApply = async (emp) => {
    const edits = editedValues[emp.id] || {};
    try {
      if (edits.monthly_salary !== undefined) {
        await api.updateEmployee(emp.id, edits.monthly_salary);
      }
      if (edits.username !== undefined) {
        await api.updateUsername(emp.id, edits.username);
      }

      const statusFields = {};
      if (edits.status !== undefined) statusFields.status = edits.status;
      if (edits.type !== undefined) statusFields.type = edits.type;
      if (edits.joining_date !== undefined)
        statusFields.joining_date = edits.joining_date || null;
      if (edits.dob !== undefined) statusFields.dob = edits.dob || null;
      if (edits.closing_date !== undefined)
        statusFields.closing_date = edits.closing_date || null;
      if (edits.probation_duration !== undefined)
        statusFields.probation_duration = edits.probation_duration || null;

      if (Object.keys(statusFields).length > 0) {
        await api.updateEmployeeStatus(emp.id, statusFields);
      }

      setRibbon({
        type: "success",
        text: "Parameters updated successfully",
        show: true,
      });
      setTimeout(() => setRibbon({ type: "", text: "", show: false }), 2000);

      setEditedValues((prev) => {
        const next = { ...prev };
        delete next[emp.id];
        return next;
      });

      if (onRefresh) onRefresh();
    } catch (err) {
      setRibbon({
        type: "error",
        text:
          err.response?.data?.detail ||
          err.response?.data?.error ||
          err.message ||
          "Failed to update",
        show: true,
      });
    }
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (
      !newEmp.name ||
      !newEmp.username ||
      !newEmp.password ||
      !newEmp.department_id ||
      !newEmp.joining_date ||
      !newEmp.dob
    ) {
      setError(
        "Name, Username, Password, Department, Joining Date and DOB are required",
      );
      return;
    }
    if (newEmp.type === "probation" && !newEmp.probation_duration) {
      setError("Probation Duration is required for probation employees");
      return;
    }
    try {
      const res = await api.createEmployee(newEmp);
      setShowAddForm(false);
      setNewEmp({
        id: "",
        username: "",
        name: "",
        monthly_salary: 0,
        password: "1234",
        role: "employee",
        department_id: "",
        status: "active",
        type: "probation",
        joining_date: "",
        closing_date: "",
        probation_duration: "",
        dob: "",
      });

      if (res.data?.device_sync === "pending") {
        setRibbon({
          type: "error",
          text: "User created in DB, but biometric device is offline. Sync queued.",
          show: true,
        });
      } else {
        setRibbon({
          type: "success",
          text: "Employee created successfully!",
          show: true,
        });
      }
      setTimeout(() => setRibbon({ type: "", text: "", show: false }), 4000);

      if (onRefresh) onRefresh();
    } catch (err) {
      setError(
        err.response?.data?.detail ||
          err.response?.data?.error ||
          "Failed to create employee",
      );
    }
  };

  const handleDelete = async (id, name) => {
    if (
      window.confirm(
        `Are you sure you want to delete ${name}? This will also delete all their attendance logs.`,
      )
    ) {
      try {
        await api.deleteEmployee(id);
        setSelectedEmp(null);
        if (onRefresh) onRefresh();
      } catch (err) {
        alert("Failed to delete employee");
      }
    }
  };

  const getInitials = (name) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "───";
    return dateStr.split("T")[0];
  };

  const CardSeparator = () => (
    <div style={{ borderTop: "1px solid #e2e8f0", margin: "0.875rem 0" }} />
  );

  const getDialogEdits = (field) => {
    if (!selectedEmp) return undefined;
    return editedValues[selectedEmp.id]?.[field];
  };

  const setDialogEdit = (field, value) => {
    handleEdit(selectedEmp.id, field, value);
  };

  const dialogStatus = selectedEmp
    ? (getDialogEdits("status") ?? selectedEmp.status)
    : "active";
  const dialogType = selectedEmp
    ? (getDialogEdits("type") ?? selectedEmp.type)
    : "probation";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Ribbon Notification */}
      {ribbon.show && (
        <div
          style={{
            position: "fixed",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
            padding: "12px 24px",
            borderRadius: "8px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            background: ribbon.type === "success" ? "#10b981" : "#ef4444",
            color: "#fff",
            boxShadow:
              "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
          }}
        >
          <span>{ribbon.text}</span>
          {ribbon.type === "error" && (
            <button
              onClick={() => setRibbon({ show: false })}
              style={{
                background: "transparent",
                border: "none",
                color: "#fff",
                cursor: "pointer",
                fontSize: "18px",
                lineHeight: "1",
              }}
            >
              &times;
            </button>
          )}
        </div>
      )}

      {/* Add Employee Form Toggle */}
      <div
        onClick={() => setShowAddForm(true)}
        className="glass-panel"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>Add Employee</h3>
          <p
            style={{
              color: "#94a3b8",
              fontSize: "0.8rem",
              margin: "0.2rem 0 0",
            }}
          >
            Manage workforce records and settings.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowAddForm(true)}
          style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          <UserPlus size={18} /> Add
        </button>
      </div>

      <Modal
        isOpen={showAddForm}
        onClose={() => {
          setShowAddForm(false);
          setError("");
        }}
        title="New Staff Member"
        size="lg"
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setShowAddForm(false);
                setError("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              form="add-employee-form"
              type="submit"
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <UserPlus size={16} /> Create Record
            </button>
          </>
        }
      >
        <form id="add-employee-form" onSubmit={handleAddSubmit}>
          {/* Row 1: Name, Username, Password */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Full Name <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                type="text"
                className="input-field"
                placeholder="John Doe"
                value={newEmp.name}
                onChange={(e) => setNewEmp({ ...newEmp, name: e.target.value })}
                required
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Username <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                type="text"
                className="input-field"
                placeholder="johndoe"
                value={newEmp.username}
                onChange={(e) =>
                  setNewEmp({ ...newEmp, username: e.target.value })
                }
                required
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Login Password <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                type="text"
                className="input-field"
                placeholder="1234"
                value={newEmp.password}
                onChange={(e) =>
                  setNewEmp({ ...newEmp, password: e.target.value })
                }
                required
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
          </div>

          {/* Row 2: Role, Department, Status, Type */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <Select
              label={
                <>
                  Role <span style={{ color: "#f43f5e" }}>*</span>
                </>
              }
              value={newEmp.role}
              onChange={(val) => setNewEmp({ ...newEmp, role: val })}
              options={[
                { value: "employee", label: "Employee" },
                { value: "admin", label: "Admin" },
              ]}
            />
            <Select
              label={
                <>
                  Department <span style={{ color: "#f43f5e" }}>*</span>
                </>
              }
              value={newEmp.department_id}
              onChange={(val) => setNewEmp({ ...newEmp, department_id: val })}
              placeholder="Select"
              options={departments.map((dep) => ({
                value: dep.id,
                label: dep.name,
              }))}
            />
            <Select
              label={
                <>
                  Status <span style={{ color: "#f43f5e" }}>*</span>
                </>
              }
              value={newEmp.status}
              onChange={(val) => setNewEmp({ ...newEmp, status: val })}
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ]}
            />
            <Select
              label={
                <>
                  Type <span style={{ color: "#f43f5e" }}>*</span>
                </>
              }
              value={newEmp.type}
              onChange={(val) => setNewEmp({ ...newEmp, type: val })}
              options={[
                { value: "probation", label: "Probation" },
                { value: "permanent", label: "Permanent" },
              ]}
            />
          </div>

          {/* Row 3: Salary, Joining Date, DOB, Closing Date */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Monthly Salary
              </label>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                }}
              >
                <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                  Rs.
                </span>
                <input
                  type="number"
                  className="input-field"
                  placeholder="50000"
                  value={newEmp.monthly_salary || ""}
                  onChange={(e) =>
                    setNewEmp({ ...newEmp, monthly_salary: e.target.value })
                  }
                  style={{
                    width: "100%",
                    padding: "0.4rem 0.5rem",
                    fontSize: "0.85rem",
                  }}
                />
              </div>
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Joining Date <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                type="date"
                className="input-field"
                value={newEmp.joining_date}
                onChange={(e) =>
                  setNewEmp({ ...newEmp, joining_date: e.target.value })
                }
                required
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Date of Birth <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                type="date"
                className="input-field"
                value={newEmp.dob}
                onChange={(e) => setNewEmp({ ...newEmp, dob: e.target.value })}
                required
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Closing Date
              </label>
              <input
                type="date"
                className="input-field"
                value={newEmp.closing_date}
                onChange={(e) =>
                  setNewEmp({ ...newEmp, closing_date: e.target.value })
                }
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
          </div>

          {/* Row 4: Probation Duration (conditional) */}
          {newEmp.type === "probation" && (
            <div style={{ marginBottom: "1rem", maxWidth: "250px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.65rem",
                  color: "#94a3b8",
                  marginBottom: "0.3rem",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Probation Duration (months){" "}
                <span style={{ color: "#f43f5e" }}>*</span>
              </label>
              <input
                type="number"
                className="input-field"
                placeholder="e.g. 3"
                min="1"
                value={newEmp.probation_duration}
                onChange={(e) =>
                  setNewEmp({ ...newEmp, probation_duration: e.target.value })
                }
                required
                style={{
                  width: "100%",
                  padding: "0.4rem 0.5rem",
                  fontSize: "0.85rem",
                }}
              />
            </div>
          )}

          {error && (
            <p
              style={{
                color: "#f43f5e",
                fontSize: "0.8rem",
                marginTop: "0.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
              <AlertCircle size={14} /> {error}
            </p>
          )}
        </form>
      </Modal>

      {/* Employee Cards Grid — compact default */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: "1rem",
        }}
      >
        {sortedEmployees.map((emp) => (
          <div
            key={emp.id}
            onClick={() => {
              setSelectedEmp(emp);
              setShowPassword(false);
              setEditedValues((prev) => ({ ...prev }));
            }}
            style={{
              background: "#fff",
              border: "1px solid rgba(226, 232, 240, 0.8)",
              borderRadius: "12px",
              padding: "1.25rem",
              cursor: "pointer",
              transition: "all 0.2s ease",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
              e.currentTarget.style.borderColor = "rgba(56, 189, 248, 0.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
              e.currentTarget.style.borderColor = "rgba(226, 232, 240, 0.8)";
            }}
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.875rem" }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "4rem",
                  // background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
                  background: "#e6e8ebff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  // color: "#fff",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  flexShrink: 0,
                }}
              >
                {getInitials(emp.name)}
              </div>

              {/* Name & Username */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.95rem",
                    color: "#1e293b",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {emp.name}
                </div>
                <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                  @{emp.id || "--"}
                </div>
              </div>

              {/* Arrow */}
              <ChevronRight
                size={18}
                style={{ color: "#cbd5e1", flexShrink: 0 }}
              />
            </div>

            {/* Badges */}
            <div
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.75rem" }}
            >
              <span
                style={{
                  padding: "3px 12px",
                  borderRadius: "12px",
                  fontSize: "0.7rem",
                  fontWeight: 600,

                  color: emp.status === "active" ? "#10b981" : "#ef4444",
                  border: `1px solid ${emp.status === "active" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                  textTransform: "upperCase",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: "0.2rem",
                    width: "10px",
                    height: "10px",
                    background: emp.status === "active" ? "#10b981" : "#ef4444",
                    borderRadius: "50%",
                  }}
                ></span>{" "}
                {emp.status || "ACTIVE"}
              </span>
              <span
                style={{
                  padding: "3px 12px",
                  borderRadius: "12px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  // background:
                  //   emp.type === "permanent"
                  //     ? "rgba(59, 130, 246, 0.15)"
                  //     : "rgba(245, 158, 11, 0.15)",
                  color: emp.type === "permanent" ? "#3b82f6" : "#f59e0b",
                  border: `1px solid ${emp.type === "permanent" ? "rgba(59, 130, 246, 0.3)" : "rgba(245, 158, 11, 0.3)"}`,
                  textTransform: "uppercase",
                }}
              >
                {emp.type || "PROBATION"}
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: "0.2rem",
                    width: "10px",
                    height: "10px",
                    background:
                      emp.type === "permanent" ? "#3b82f6" : "#f59e0b",
                    borderRadius: "50%",
                  }}
                ></span>
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Detail Dialog */}
      <Modal
        isOpen={!!selectedEmp}
        onClose={() => setSelectedEmp(null)}
        title={selectedEmp ? `${selectedEmp.name}` : ""}
        size="md"
        footer={
          selectedEmp && (
            <>
              <button
                className="btn btn-primary"
                onClick={() => handleApply(selectedEmp)}
              >
                Apply
              </button>
              {/* Delete */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="btn"
                  style={{
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.8rem",
                    background: "rgba(244, 63, 94, 0.1)",
                    color: "#f43f5e",
                    border: "1px solid rgba(244, 63, 94, 0.2)",
                  }}
                  onClick={() => handleDelete(selectedEmp.id, selectedEmp.name)}
                >
                  <Trash2
                    size={14}
                    style={{
                      marginRight: "0.3rem",
                      verticalAlign: "middle",
                    }}
                  />{" "}
                  Delete Record
                </button>
              </div>
            </>
          )
        }
      >
        {selectedEmp && (
          <div>
            {/* Header: Avatar + Name + ID */}
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.875rem" }}
            >
              <div
                style={{
                  width: "48px",
                  height: "48px",
                  borderRadius: "10px",
                  // background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",

                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  // color: "#fff",
                  fontWeight: 700,
                  fontSize: "0.9rem",
                  flexShrink: 0,
                }}
              >
                {getInitials(selectedEmp.name)}
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "1rem",
                    color: "#1e293b",
                  }}
                >
                  {selectedEmp.name}
                </div>
                <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  @{selectedEmp.username || "set username"}
                </div>
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "#94a3b8",
                  fontWeight: 500,
                }}
              >
                ID: {selectedEmp.id}
              </div>
            </div>

            <CardSeparator />

            {/* Badges + Joined Date */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                flexWrap: "wrap",
                justifyContent: "space-between",
              }}
            >
              <span
                onClick={() =>
                  setDialogEdit(
                    "status",
                    dialogStatus === "active" ? "inactive" : "active",
                  )
                }
                style={{
                  padding: "3px 12px",
                  borderRadius: "12px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  background:
                    dialogStatus === "active"
                      ? "rgba(16, 185, 129, 0.15)"
                      : "rgba(239, 68, 68, 0.15)",
                  color: dialogStatus === "active" ? "#10b981" : "#ef4444",
                  border: `1px solid ${dialogStatus === "active" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                  textTransform: "capitalize",
                }}
                title="Click to toggle"
              >
                {dialogStatus}
              </span>
              <span
                onClick={() =>
                  setDialogEdit(
                    "type",
                    dialogType === "probation" ? "permanent" : "probation",
                  )
                }
                style={{
                  padding: "3px 12px",
                  borderRadius: "12px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  background:
                    dialogType === "permanent"
                      ? "rgba(59, 130, 246, 0.15)"
                      : "rgba(245, 158, 11, 0.15)",
                  color: dialogType === "permanent" ? "#3b82f6" : "#f59e0b",
                  border: `1px solid ${dialogType === "permanent" ? "rgba(59, 130, 246, 0.3)" : "rgba(245, 158, 11, 0.3)"}`,
                  textTransform: "capitalize",
                }}
                title="Click to toggle"
              >
                {dialogType}
              </span>
              <div style={{ marginLeft: "auto" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginBottom: "0.3rem",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Joined
                </label>
                <input
                  type="date"
                  className="input-field"
                  value={
                    (getDialogEdits("joining_date") !== undefined
                      ? getDialogEdits("joining_date")
                      : selectedEmp.joining_date?.split("T")[0]) || ""
                  }
                  onChange={(e) =>
                    setDialogEdit("joining_date", e.target.value)
                  }
                  style={{ padding: "0.35rem 0.5rem", fontSize: "0.8rem" }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginBottom: "0.3rem",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  DOB
                </label>
                <input
                  type="date"
                  className="input-field"
                  value={
                    (getDialogEdits("dob") !== undefined
                      ? getDialogEdits("dob")
                      : selectedEmp.dob?.split("T")[0]) || ""
                  }
                  onChange={(e) => setDialogEdit("dob", e.target.value)}
                  style={{ padding: "0.35rem 0.5rem", fontSize: "0.8rem" }}
                />
              </div>
            </div>

            <CardSeparator />

            {/* Salary + Password */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: "0.75rem",
                alignItems: "start",
              }}
            >
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginBottom: "0.3rem",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Monthly Salary
                </label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                    Rs.
                  </span>
                  <input
                    type="number"
                    className="input-field no-spinners"
                    defaultValue={selectedEmp.monthly_salary}
                    onChange={(e) =>
                      setDialogEdit("monthly_salary", e.target.value)
                    }
                    style={{
                      width: "100%",
                      padding: "0.4rem 0.5rem",
                      fontSize: "0.85rem",
                    }}
                  />
                </div>
              </div>

              {/* passowrd */}
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginBottom: "0.3rem",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Password
                </label>
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <input
                    type={showPassword ? "text" : "password"}
                    className="input-field"
                    defaultValue={
                      selectedEmp.password_hash || selectedEmp.password
                    }
                    onBlur={(e) =>
                      onUpdatePassword(selectedEmp.id, e.target.value)
                    }
                    style={{
                      width: "100%",
                      padding: "0.4rem 2rem 0.4rem 0.5rem",
                      fontSize: "0.85rem",
                      letterSpacing: showPassword ? "normal" : "2px",
                      fontWeight: 600,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: "absolute",
                      right: "6px",
                      background: "none",
                      border: "none",
                      color: "#94a3b8",
                      cursor: "pointer",
                      padding: "2px",
                    }}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </div>

            <CardSeparator />

            {/* Closing Date + Probation */}
            <div
              style={{ display: "flex", gap: "1.5rem", alignItems: "start" }}
            >
              <div style={{ flex: 1 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginBottom: "0.3rem",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Closing Date
                </label>
                <input
                  type="date"
                  className="input-field"
                  value={
                    (getDialogEdits("closing_date") !== undefined
                      ? getDialogEdits("closing_date")
                      : selectedEmp.closing_date?.split("T")[0]) || ""
                  }
                  onChange={(e) =>
                    setDialogEdit("closing_date", e.target.value)
                  }
                  style={{
                    width: "100%",
                    padding: "0.4rem 0.5rem",
                    fontSize: "0.85rem",
                  }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.65rem",
                    color: "#94a3b8",
                    marginBottom: "0.3rem",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Probation
                </label>
                {dialogType === "probation" ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.3rem",
                    }}
                  >
                    <input
                      type="number"
                      className="input-field no-spinners"
                      min="1"
                      value={
                        getDialogEdits("probation_duration") ??
                        selectedEmp.probation_duration ??
                        ""
                      }
                      onChange={(e) =>
                        setDialogEdit("probation_duration", e.target.value)
                      }
                      style={{
                        width: "70px",
                        padding: "0.4rem 0.5rem",
                        fontSize: "0.85rem",
                      }}
                    />
                    <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                      months
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "0.4rem 0",
                      fontSize: "0.85rem",
                      color: "#94a3b8",
                    }}
                  >
                    ───
                  </div>
                )}
              </div>
            </div>

            <CardSeparator />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default StaffManager;
