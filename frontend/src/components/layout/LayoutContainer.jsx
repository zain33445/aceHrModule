import React from 'react';
import Navbar from './Navbar';
import Sidebar from './Sidebar';

export const LayoutContainer = ({
  children,
  user,
  onLogout,
  activeTab,
  onTabChange,
  breadcrumbs = [],
  notifications = [],
  onNotificationClick,
  grantedTabs = [],
}) => {
  return (
    <div className="h-screen bg-neutral-50 flex flex-col overflow-hidden">
      {/* Navbar */}
      <Navbar
        user={user}
        onLogout={onLogout}
        breadcrumbs={breadcrumbs}
        notifications={notifications}
        onNotificationClick={onNotificationClick}
        onTabChange={onTabChange}
      />

      {/* Main Container */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          activeTab={activeTab}
          onTabChange={onTabChange}
          user={user}
          grantedTabs={grantedTabs}
        />

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto no-scrollbar">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default LayoutContainer;
