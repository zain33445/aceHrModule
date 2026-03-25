import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  Users,
  Clock,
  DollarSign,
  FileText,
  Menu,
  X,
  ChevronRight,
  Settings,
  Building2,
  CalendarDays,
  CalendarHeart,
  PlaneTakeoff,
  Activity,
  Download
} from 'lucide-react';

export const Sidebar = ({ activeTab = 'dashboard', onTabChange, userRole = 'employee' }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const normalizedRole = userRole?.toLowerCase() === 'administrator' ? 'admin' : userRole;

  // Navigation items for different roles
  const navItems =
    normalizedRole === 'admin'
      ? [
          {
            id: 'overview',
            label: 'Analytics',
            icon: LayoutDashboard,
            href: '#',
          },
          {
            id: 'departments',
            label: 'Departments',
            icon: Building2,
            href: '#',
          },
          {
            id: 'employees',
            label: 'Staff Management',
            icon: Users,
            href: '#',
          },
          {
            id: 'attendance',
            label: 'Attendance',
            icon: Clock,
            href: '#',
          },
          {
            id: 'leaves',
            label: 'Leave Requests',
            icon: PlaneTakeoff,
            href: '#',
          },
          {
            id: 'holidays',
            label: 'Holidays',
            icon: CalendarHeart,
            href: '#',
          },
          {
            id: 'payroll',
            label: 'Payroll',
            icon: DollarSign,
            href: '#',
          },
          {
            id: 'disputes',
            label: 'Disputes',
            icon: FileText,
            href: '#',
          },
          {
            id: 'export',
            label: 'Data Export',
            icon: Download,
            href: '#',
          },
          {
            id: 'audit',
            label: 'Audit Logs',
            icon: Activity,
            href: '#',
          },
          {
            id: 'settings',
            label: 'Settings',
            icon: Settings,
            href: '#',
          },
        ]
      : [
          {
            id: 'overview',
            label: 'Dashboard',
            icon: LayoutDashboard,
            href: '#',
          },
          {
            id: 'attendance',
            label: 'Attendance Log',
            icon: Clock,
            href: '#',
          },
          {
            id: 'salary',
            label: 'Salary',
            icon: DollarSign,
            href: '#',
          },
          {
            id: 'disputes',
            label: 'Disputes',
            icon: FileText,
            href: '#',
          },
          {
            id: 'settings',
            label: 'Settings',
            icon: Settings,
            href: '#',
          },
        ];

  const handleNavClick = (id) => {
    onTabChange?.(id);
    setIsMobileOpen(false);
  };

  return (
    <>
      {/* Mobile Menu Button */}
      <motion.button
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsMobileOpen(!isMobileOpen)}
        className="fixed top-16 left-4 z-40 p-2 lg:hidden bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50"
      >
        {isMobileOpen ? <X size={20} /> : <Menu size={20} />}
      </motion.button>

      {/* Backdrop for Mobile */}
      {isMobileOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setIsMobileOpen(false)}
          className="fixed inset-0 bg-black/20 lg:hidden z-30"
        />
      )}

      {/* Sidebar */}
      <motion.aside
        initial={false}
        animate={{
          width: isCollapsed ? '80px' : '250px',
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className={`fixed left-0 top-16 h-[calc(100vh-64px)] bg-white border-r border-neutral-200 overflow-hidden flex flex-col z-35 ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0 transition-transform lg:transition-none`}
      >
        {/* Collapse Button */}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="hidden lg:flex absolute -right-3 top-4 w-6 h-6 bg-white border border-neutral-200 rounded-full items-center justify-center hover:bg-neutral-50 z-10"
        >
          <ChevronRight
            size={14}
            className={`transition-transform ${
              isCollapsed ? 'rotate-0' : 'rotate-180'
            }`}
          />
        </motion.button>

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <motion.button
                key={item.id}
                whileHover={{ x: 5 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                  isActive
                    ? 'bg-primary-100 text-primary-700 font-medium'
                    : 'text-neutral-600 hover:bg-neutral-100'
                } ${isCollapsed ? 'justify-center' : ''}`}
                title={isCollapsed ? item.label : ''}
              >
                <Icon size={20} className="flex-shrink-0" />
                {!isCollapsed && <span className="text-sm">{item.label}</span>}

                {isActive && !isCollapsed && (
                  <div className="ml-auto w-1 h-6 bg-primary-500 rounded-full" />
                )}
              </motion.button>
            );
          })}
        </nav>

        {/* Footer - Construction Theme Touch */}
        <div className={`border-t border-neutral-200 p-3 ${isCollapsed ? 'text-center' : ''}`}>
          <div
            className={`text-xs font-medium text-neutral-500 flex items-center gap-2 ${
              isCollapsed ? 'justify-center' : ''
            }`}
          >
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            {!isCollapsed && <span>Online</span>}
          </div>
        </div>
      </motion.aside>

      {/* Sidebar Spacing */}
      <div
        className="hidden lg:block"
        style={{
          width: isCollapsed ? '80px' : '250px',
          transition: 'width 0.3s ease',
        }}
      />
    </>
  );
};

export default Sidebar;
