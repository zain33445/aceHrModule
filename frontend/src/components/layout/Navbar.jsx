import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Bell, ChevronDown, LogOut } from 'lucide-react';
import Avatar from '../common/Avatar';
import aceLogo from '../../assets/aceLogo.png';


export const Navbar = ({
  user,
  onLogout,
  breadcrumbs = [],
  notifications = [],
  onNotificationClick,
  onTabChange,
}) => {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const navRef = useRef(null);

  useEffect(() => {
    if (!showUserMenu && !showNotifications) return;

    function handleClickOutside(event) {
      if (navRef.current && !navRef.current.contains(event.target)) {
        setShowUserMenu(false);
        setShowNotifications(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUserMenu, showNotifications]);

  return (
    <motion.nav
      ref={navRef}
      className="sticky top-0 z-30 bg-white border-b border-neutral-200 shadow-sm h-16 flex items-center"
    >
      <div className="max-w-full w-full px-4 sm:px-6 lg:px-4 h-full">
        <div className="relative flex items-center justify-between h-full">
          
          {/* Left: User Menu */}
          <div className="flex items-center flex-1">
            <div className="relative">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 p-1 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <Avatar
                  name={user?.name || 'User'}
                  size="sm"
                  className="flex-shrink-0"
                />
                <div className="hidden sm:flex flex-col items-start text-sm">
                  <span className="font-medium text-neutral-900 leading-none">
                    {user?.name || 'User'}
                  </span>
                  <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold mt-0.5">
                    {user?.role || 'Employee'}
                  </span>
                </div>
                <ChevronDown
                  size={14}
                  className={`text-neutral-400 transition-transform ${showUserMenu ? 'rotate-180' : ''}`}
                />
              </motion.button>

              {/* User Dropdown */}
              {showUserMenu && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute left-0 mt-2 w-48 bg-white rounded-lg shadow-xl border border-neutral-100 py-2 z-40"
                >
                  <button
                    onClick={onLogout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-error hover:bg-error/5 transition-colors font-medium"
                  >
                    <LogOut size={16} />
                    Logout
                  </button>
                </motion.div>
              )}
            </div>
          </div>

          {/* Center: Branding */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 pointer-events-none">
            <div className="flex-shrink-0">
              <img 
                src={aceLogo} 
                alt="aceLogo" 
                className="w-10 h-10 object-contain rounded-lg shadow-sm"
              />
            </div>
            <h2 className='text-4xl text-primary-500 font-bebas-neue tracking-wider leading-none mt-1'>
              ACE Services
            </h2>
          </div>

          {/* Right: Notifications */}
          <div className="flex items-center justify-end flex-1">
            <div className="relative">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowNotifications(!showNotifications)}
                className="relative p-2 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <Bell size={20} className="text-neutral-600" />
                {unreadCount > 0 && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-0 right-0 w-5 h-5 bg-error text-white text-xs font-bold rounded-full flex items-center justify-center"
                  >
                    {unreadCount}
                  </motion.span>
                )}
              </motion.button>

              {/* Notifications Dropdown */}
              {showNotifications && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-neutral-200 p-4 z-40"
                >
                  <h3 className="font-semibold text-neutral-900 mb-3">Notifications</h3>
                  {notifications.length > 0 ? (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {notifications.slice(0, 5).map((notif) => (
                        <div
                          key={notif.id}
                          className={`p-3 rounded-md cursor-pointer transition-colors ${
                            notif.read
                              ? 'bg-neutral-50'
                              : 'bg-primary-50 hover:bg-primary-100'
                          }`}
                          onClick={() => onNotificationClick?.(notif)}
                        >
                          <p className="text-sm font-medium text-neutral-900">
                            {notif.title}
                          </p>
                          <p className="text-xs text-neutral-600 mt-1">
                            {notif.message}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-600 text-center py-4">
                      No notifications
                    </p>
                  )}
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.nav>
  );
};

export default Navbar;
