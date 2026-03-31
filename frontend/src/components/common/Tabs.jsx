import React, { useState } from 'react';
import { motion } from 'framer-motion';

export const Tabs = ({
  tabs,
  defaultTab = 0,
  onChange,
  variant = 'tabs',
  className = '',
}) => {
  const [activeTab, setActiveTab] = useState(defaultTab);

  const handleTabChange = (index) => {
    setActiveTab(index);
    onChange?.(index, tabs[index].id);
  };

  const tabsVariant = {
    tabs: 'border-b border-neutral-200',
    pills: 'bg-neutral-100 p-1 rounded-lg inline-flex gap-1',
  };

  const tabButtonVariant = {
    tabs: {
      base: 'relative px-4 py-3 text-sm font-medium text-neutral-600 hover:text-neutral-900 transition-colors',
      active: 'text-primary-600',
    },
    pills: {
      base: 'px-4 py-2 rounded-md text-sm font-medium transition-all',
      active: 'bg-white text-primary-600 shadow-sm',
      inactive: 'text-neutral-600 hover:text-neutral-900',
    },
  };

  return (
    <div className={className}>
      <div className={`flex gap-2 ${tabsVariant[variant]}`}>
        {tabs.map((tab, index) => (
          <motion.button
            key={tab.id || index}
            onClick={() => handleTabChange(index)}
            className={`${tabButtonVariant[variant].base} ${
              activeTab === index
                ? tabButtonVariant[variant].active
                : variant === 'pills'
                ? tabButtonVariant[variant].inactive
                : ''
            }`}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            {tab.icon && <span className="mr-2 inline-block">{tab.icon}</span>}
            {tab.label}
            {variant === 'tabs' && activeTab === index && (
              <motion.div
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500"
                layoutId="underline"
              />
            )}
          </motion.button>
        ))}
      </div>

      <motion.div
        key={activeTab}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2 }}
        className="mt-4"
      >
        {tabs[activeTab]?.content}
      </motion.div>
    </div>
  );
};

export default Tabs;
