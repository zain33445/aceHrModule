import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import packageJson from '../../../package.json';
import {
  LayoutDashboard,
  Users,
  Clock,
  Banknote,
  FileText,
  Menu,
  X,
  ChevronRight,
  Settings,
  Building2,
  CalendarHeart,
  PlaneTakeoff,
  Activity,
  Download,
  Camera,
  Video,
  ShieldCheck,
} from 'lucide-react';

export const Sidebar = ({ activeTab = 'overview', onTabChange, user, grantedTabs = [] }) => {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem('isCollapsed');
      return saved !== null ? JSON.parse(saved) : false;
    } catch {
      return true;
    }
  });
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isClientOnline, setIsClientOnline] = useState(navigator.onLine);
  const [isBackendOnline, setIsBackendOnline] = useState(true);

  useEffect(() => {
    const handleOnline = () => setIsClientOnline(true);
    const handleOffline = () => setIsClientOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const checkBackend = async () => {
      if (!navigator.onLine) return; // Don't check if client is offline
      try {
        const baseUrl = import.meta.env.VITE_API_BASE?.replace(/\/api\/?$/, '') || 'http://localhost:5000';
        const res = await fetch(baseUrl);
        setIsBackendOnline(res.ok);
      } catch (e) {
        setIsBackendOnline(false);
      }
    };

    checkBackend();
    const interval = setInterval(checkBackend, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, []);

  let statusColor = 'bg-success-500';
  let statusText = 'System Online';

  if (!isClientOnline) {
    statusColor = 'bg-yellow-500';
    statusText = 'Client Offline';
  } else if (!isBackendOnline) {
    statusColor = 'bg-red-500';
    statusText = 'Server Offline';
  }

  const userRole = user?.role;
  const isLead = user?.is_lead;
  const normalizedRole = userRole?.toLowerCase();

  // Navigation items for different roles
  let navItems =
    normalizedRole === 'admin'
      ? [
          { id: 'overview', label: 'Analytics', icon: LayoutDashboard },
          { id: 'attendance', label: 'Attendance', icon: Clock },
          { id: 'payroll', label: 'Payroll', icon: Banknote },
          { id: 'leaves', label: 'Leave Requests', icon: PlaneTakeoff },
          { id: 'leave-allocation', label: 'Leave Allocation', icon: CalendarHeart },
          { id: 'disputes', label: 'Appeals', icon: FileText },
          { id: 'screenshots', label: 'Screenshots', icon: Camera },
          { id: 'recording', label: 'Recording', icon: Video },
          { id: 'employees', label: 'Employees', icon: Users },
          { id: 'departments', label: 'Departments', icon: Building2 },
          { id: 'holidays', label: 'Holidays', icon: CalendarHeart },
          { id: 'export', label: 'Data Export', icon: Download },
          { id: 'audit', label: 'Audit Logs', icon: Activity },
          { id: 'feature-access', label: 'Feature Access', icon: ShieldCheck },
          { id: 'settings', label: 'Settings', icon: Settings },
        ]
      : [
          { id: 'overview', label: 'Dashboard', icon: LayoutDashboard },
          { id: 'attendance', label: 'Attendance Log', icon: Clock },
          { id: 'salary', label: 'Salary History', icon: Banknote },
          { id: 'leaves', label: 'Leave Requests', icon: PlaneTakeoff },
          { id: 'disputes', label: 'My Appeals', icon: FileText },
          { id: 'settings', label: 'Settings', icon: Settings },
        ];

  // Add granted admin tabs for non-admin users (HR feature access)
  if (normalizedRole !== 'admin' && grantedTabs.length > 0) {
    const adminTabNavMap = {
      payroll: { id: 'admin-payroll', label: 'Payroll', icon: Banknote },
      leaves: { id: 'admin-leaves', label: 'Leave Requests (Admin)', icon: PlaneTakeoff },
      'leave-allocation': { id: 'admin-leave-allocation', label: 'Leave Allocation', icon: CalendarHeart },
      holidays: { id: 'admin-holidays', label: 'Holidays', icon: CalendarHeart },
      departments: { id: 'admin-departments', label: 'Departments', icon: Building2 },
      export: { id: 'admin-export', label: 'Data Export', icon: Download },
      audit: { id: 'admin-audit', label: 'Audit Logs', icon: Activity },
      overview: { id: 'admin-overview', label: 'Analytics', icon: LayoutDashboard },
      attendance: { id: 'admin-attendance', label: 'Attendance', icon: Clock },
      screenshots: { id: 'admin-screenshots', label: 'Screenshots', icon: Camera },
      recording: { id: 'admin-recording', label: 'Recording', icon: Video },
      employees: { id: 'admin-employees', label: 'Employees', icon: Users },
      disputes: { id: 'admin-disputes', label: 'Appeals', icon: FileText },
      settings: { id: 'admin-settings', label: 'Settings (Admin)', icon: Settings },
    };

    for (const tabKey of grantedTabs) {
      const mapped = adminTabNavMap[tabKey];
      if (mapped && !navItems.find((n) => n.id === mapped.id)) {
        navItems.push(mapped);
      }
    }
  }

  // Add Lead Dashboard if user is a lead
  if (normalizedRole !== 'admin' && isLead) {
    navItems.splice(4, 0, {
      id: 'team_disputes',
      label: 'Team Appeals',
      icon: Users,
    });
  }

  useEffect(() => {
    localStorage.setItem('isCollapsed', JSON.stringify(isCollapsed));
  }, [isCollapsed]);

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
        className="fixed top-5 left-4 z-50 p-2 lg:hidden bg-white border border-neutral-200 rounded-lg shadow-sm"
      >
        {isMobileOpen ? <X size={20} /> : <Menu size={20} />}
      </motion.button>

      {/* Backdrop for Mobile */}
      <AnimatePresence>
        {isMobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsMobileOpen(false)}
            className="fixed inset-0 bg-black/20 lg:hidden z-40 backdrop-blur-sm"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        initial={false}
        animate={{
          width: isCollapsed ? '80px' : '250px',
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className={`fixed left-0 top-20 h-[calc(100vh-80px)] bg-white border-r border-neutral-200 flex flex-col z-40 transition-transform lg:transition-none ${
          isMobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Collapse Button */}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="hidden lg:flex absolute -right-3 top-6 w-6 h-6 bg-white border border-neutral-200 rounded-full items-center justify-center hover:bg-neutral-50 shadow-sm z-10"
        >
          <ChevronRight
            size={14}
            className={`text-neutral-1000 transition-transform ${
              isCollapsed ? 'rotate-0' : 'rotate-180'
            }`}
          />
        </motion.button>

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const isLast = index === navItems.length - 1;

            return (
              <motion.button
                key={item.id}
                whileHover={{ x: 4 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-3 border-b-[2px] transition-all duration-200 group ${
                  isActive
                    ? 'bg-primary-50 border-primary-500 text-primary-600 shadow-sm rounded-2xl'
                    : `text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 hover:rounded-2xl ${
                        isLast ? 'border-transparent' : 'border-neutral-100 hover:border-neutral-300'
                      }`
                } ${isCollapsed ? 'justify-center' : ''}`}
                title={isCollapsed ? item.label : ''}
              >
                <div className={`p-1.5 rounded-lg transition-colors ${
                  isActive ? 'bg-white shadow-sm' : 'bg-transparent group-hover:bg-white/50'
                }`}>
                  <Icon size={20} className="flex-shrink-0" />
                </div>
                {!isCollapsed && (
                  <span className={`text-sm font-medium whitespace-nowrap transition-opacity duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>
                    {item.label}
                  </span>
                )}

                {isActive && !isCollapsed && (
                  <motion.div 
                    layoutId="activeIndicator"
                    className="ml-auto w-1 h-5 bg-primary-500 rounded-full" 
                  />
                )}
              </motion.button>
            );
          })}
        </nav>

        {/* Footer */}
        <div className={`border-t border-neutral-100 p-4 ${isCollapsed ? 'items-center' : ''}`}>
          <div
            className={`flex items-center gap-3 px-2 ${
              isCollapsed ? 'justify-center' : ''
            }`}
          >
            <div className="relative">
              <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
              <div className={`absolute inset-0 w-2.5 h-2.5 rounded-full ${statusColor} animate-ping opacity-75`} />
            </div>
            {!isCollapsed && (
              <div className="flex flex-col">
                <span className="text-xs font-bold text-neutral-900">{statusText}</span>
                <span className="text-[10px] text-neutral-500">v{packageJson.version}</span>
              </div>
            )}
          </div>
        </div>
      </motion.aside>

      {/* Sidebar Spacing */}
      <div
        className="hidden lg:block h-full flex-shrink-0"
        style={{
          width: isCollapsed ? '80px' : '250px',
          transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />
    </>
  );
};

export default Sidebar;
