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
  ChevronDown,
  Settings,
  Building2,
  CalendarHeart,
  PlaneTakeoff,
  Activity,
  Download,
  Camera,
  Video,
  ShieldCheck,
  Timer,
  BookOpen,
} from 'lucide-react';

// Grouped nav structure
const adminNavGroups = [
  {
    label: 'Overview',
    items: [
      { id: 'overview', label: 'Analytics', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Workforce',
    items: [
      { id: 'employees', label: 'Employees', icon: Users },
      { id: 'departments', label: 'Departments', icon: Building2 },
    ],
  },
  {
    label: 'Time & Attendance',
    items: [
      { id: 'attendance', label: 'Attendance', icon: Clock },
      { id: 'holidays', label: 'Holidays', icon: CalendarHeart },
      { id: 'overtime', label: 'Overtime', icon: Timer },
    ],
  },
  {
    label: 'Compensation',
    items: [
      { id: 'payroll', label: 'Payroll', icon: Banknote },
      { id: 'leaves', label: 'Leave Requests', icon: PlaneTakeoff },
      { id: 'leave-allocation', label: 'Leave Allocation', icon: CalendarHeart },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { id: 'screenshots', label: 'Screenshots', icon: Camera },
      { id: 'recording', label: 'Recording', icon: Video },
    ],
  },
  {
    label: 'Management',
    items: [
      { id: 'disputes', label: 'Appeals', icon: FileText },
      { id: 'export', label: 'Data Export', icon: Download },
      { id: 'audit', label: 'Audit Logs', icon: Activity },
      { id: 'feature-access', label: 'Feature Access', icon: ShieldCheck },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
  {
    label: 'Company',
    items: [
      { id: 'policies', label: 'Policies', icon: BookOpen },
      { id: 'sop', label: 'SOP', icon: FileText },
    ],
  },
];

const employeeNavGroups = [
  {
    label: 'Overview',
    items: [
      { id: 'overview', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Time & Attendance',
    items: [
      { id: 'attendance', label: 'Attendance Log', icon: Clock },
      { id: 'overtime', label: 'Overtime', icon: Timer },
    ],
  },
  {
    label: 'Compensation',
    items: [
      { id: 'salary', label: 'Salary History', icon: Banknote },
      { id: 'leaves', label: 'Leave Requests', icon: PlaneTakeoff },
    ],
  },
  {
    label: 'My Affairs',
    items: [
      { id: 'disputes', label: 'My Appeals', icon: FileText },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
  {
    label: 'Company',
    items: [
      { id: 'policies', label: 'Policies', icon: BookOpen },
      { id: 'sop', label: 'SOP', icon: FileText },
    ],
  },
];

// Map granted admin tab keys to grouped structure for non-admin HR users
const adminGrantGroupMap = {
  overview: { group: 'Overview', item: { id: 'admin-overview', label: 'Analytics', icon: LayoutDashboard } },
  employees: { group: 'Workforce', item: { id: 'admin-employees', label: 'Employees', icon: Users } },
  departments: { group: 'Workforce', item: { id: 'admin-departments', label: 'Departments', icon: Building2 } },
  attendance: { group: 'Time & Attendance', item: { id: 'admin-attendance', label: 'Attendance', icon: Clock } },
  holidays: { group: 'Time & Attendance', item: { id: 'admin-holidays', label: 'Holidays', icon: CalendarHeart } },
  overtime: { group: 'Time & Attendance', item: { id: 'admin-overtime', label: 'Overtime', icon: Timer } },
  payroll: { group: 'Compensation', item: { id: 'admin-payroll', label: 'Payroll', icon: Banknote } },
  leaves: { group: 'Compensation', item: { id: 'admin-leaves', label: 'Leave Requests (Admin)', icon: PlaneTakeoff } },
  'leave-allocation': { group: 'Compensation', item: { id: 'admin-leave-allocation', label: 'Leave Allocation', icon: CalendarHeart } },
  screenshots: { group: 'Monitoring', item: { id: 'admin-screenshots', label: 'Screenshots', icon: Camera } },
  recording: { group: 'Monitoring', item: { id: 'admin-recording', label: 'Recording', icon: Video } },
  disputes: { group: 'Management', item: { id: 'admin-disputes', label: 'Appeals', icon: FileText } },
  export: { group: 'Management', item: { id: 'admin-export', label: 'Data Export', icon: Download } },
  audit: { group: 'Management', item: { id: 'admin-audit', label: 'Audit Logs', icon: Activity } },
  settings: { group: 'Management', item: { id: 'admin-settings', label: 'Settings (Admin)', icon: Settings } },
};

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
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try {
      const saved = localStorage.getItem('collapsedSidebarGroups');
      return saved !== null ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

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
      if (!navigator.onLine) return;
      try {
        const baseUrl = import.meta.env.VITE_API_BASE?.replace(/\/api\/?$/, '') || 'http://localhost:5000';
        const res = await fetch(baseUrl);
        setIsBackendOnline(res.ok);
      } catch {
        setIsBackendOnline(false);
      }
    };

    checkBackend();
    const interval = setInterval(checkBackend, 30000);
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

  // Build grouped nav items
  let groups = normalizedRole === 'admin'
    ? adminNavGroups.map(g => ({ ...g, items: [...g.items] }))
    : employeeNavGroups.map(g => ({ ...g, items: [...g.items] }));

  // Add granted admin tabs for non-admin users into their respective groups
  if (normalizedRole !== 'admin' && grantedTabs.length > 0) {
    // Find or create the "Admin" section group
    const adminSections = [];

    for (const tabKey of grantedTabs) {
      const mapping = adminGrantGroupMap[tabKey];
      if (!mapping) continue;

      // Find existing group with same label, or create one
      let targetGroup = adminSections.find(g => g.label === mapping.group);
      if (!targetGroup) {
        targetGroup = { label: mapping.group, items: [], isAdmin: true };
        adminSections.push(targetGroup);
      }
      if (!targetGroup.items.find(i => i.id === mapping.item.id)) {
        targetGroup.items.push(mapping.item);
      }
    }

    // Add admin sections with a divider label
    for (const section of adminSections) {
      // Check if a group with the same label already exists
      const existingGroup = groups.find(g => g.label === section.label && !g.isAdmin);
      if (existingGroup) {
        // Append admin items to existing group
        for (const item of section.items) {
          if (!existingGroup.items.find(i => i.id === item.id)) {
            existingGroup.items.push(item);
          }
        }
      } else {
        groups.push(section);
      }
    }
  }

  // Add Team Appeals for lead users in "My Affairs" group (employee) or create it
  if (normalizedRole !== 'admin' && isLead) {
    const myAffairsGroup = groups.find(g => g.label === 'My Affairs');
    if (myAffairsGroup) {
      myAffairsGroup.items.splice(0, 0, { id: 'team_disputes', label: 'Team Appeals', icon: Users });
    } else {
      groups.push({
        label: 'My Affairs',
        items: [{ id: 'team_disputes', label: 'Team Appeals', icon: Users }],
      });
    }
  }

  useEffect(() => {
    localStorage.setItem('isCollapsed', JSON.stringify(isCollapsed));
  }, [isCollapsed]);

  useEffect(() => {
    localStorage.setItem('collapsedSidebarGroups', JSON.stringify(collapsedGroups));
  }, [collapsedGroups]);

  const handleNavClick = (id) => {
    onTabChange?.(id);
    setIsMobileOpen(false);
  };

  const toggleGroup = (label) => {
    setCollapsedGroups(prev => ({ ...prev, [label]: !prev[label] }));
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
        <nav className="flex-1 overflow-y-auto p-4 space-y-1 no-scrollbar">
          {groups.map((group, groupIndex) => {
            const isGroupCollapsed = collapsedGroups[group.label] || false;

            return (
              <div key={group.label} className={groupIndex > 0 ? 'mt-3' : ''}>
                {/* Group Header */}
                {!isCollapsed && (
                  <button
                    onClick={() => toggleGroup(group.label)}
                    className="w-full flex items-center justify-between px-3 py-1.5 mb-1 group/header"
                  >
                    <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 group-hover/header:text-neutral-600 transition-colors">
                      {group.label}
                    </span>
                    <ChevronDown
                      size={12}
                      className={`text-neutral-400 transition-transform duration-200 ${
                        isGroupCollapsed ? '-rotate-90' : 'rotate-0'
                      }`}
                    />
                  </button>
                )}

                {/* Group Items */}
                <AnimatePresence initial={false}>
                  {(!isGroupCollapsed || isCollapsed) && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeTab === item.id;

                        return (
                          <motion.button
                            key={item.id}
                            whileHover={{ x: 4 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => handleNavClick(item.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 transition-all duration-200 group ${
                              isActive
                                ? 'bg-primary-50 text-primary-600 shadow-sm rounded-2xl'
                                : `text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 hover:rounded-2xl`
                            } ${isCollapsed ? 'justify-center' : ''}`}
                            title={isCollapsed ? item.label : ''}
                          >
                            <div className={`p-1.5 rounded-lg transition-colors ${
                              isActive ? 'bg-white shadow-sm' : 'bg-transparent group-hover:bg-white/50'
                            }`}>
                              <Icon size={18} className="flex-shrink-0" />
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
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
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
