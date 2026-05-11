import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check } from 'lucide-react';

export const Select = React.forwardRef(({
  label,
  options = [],
  error,
  disabled = false,
  placeholder = 'Select an option...',
  value,
  onChange,
  className = '',
  icon: Icon,
  ...props
}, ref) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const selectedOption = options.find(opt => opt.value === value);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = (optionValue) => {
    onChange?.(optionValue);
    setIsOpen(false);
  };

  return (
    <div className={`w-full ${className}`} ref={containerRef}>
      {label && (
        <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen(!isOpen)}
          className={`
            w-full flex items-center justify-between px-4 py-3 bg-white border rounded-xl transition-all duration-200
            ${error ? 'border-error ring-4 ring-error/10' : 'border-neutral-200 focus:border-primary-500 focus:ring-4 focus:ring-primary-500/10'}
            ${disabled ? 'bg-neutral-50 text-neutral-400 cursor-not-allowed opacity-60' : 'hover:border-neutral-300 hover:shadow-md'}
            ${isOpen ? 'border-primary-500 ring-4 ring-primary-500/10' : ''}
          `}
        >
          <div className="flex items-center gap-3 overflow-hidden">
            {Icon && <Icon size={18} className={`${isOpen ? 'text-primary-500' : 'text-neutral-400'}`} />}
            <span className={`truncate text-sm ${!selectedOption ? 'text-neutral-400' : 'text-neutral-900 font-medium'}`}>
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          </div>
          <ChevronDown
            size={18}
            className={`text-neutral-400 transition-transform duration-200 flex-shrink-0 ${isOpen ? 'rotate-180 text-primary-500' : ''}`}
          />
        </button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 4, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute z-50 w-full mt-2 bg-white border border-neutral-100 rounded-xl shadow-2xl overflow-hidden py-1 max-h-60 overflow-y-auto no-scrollbar"
            >
              {options.length === 0 ? (
                <div className="px-4 py-3 text-sm text-neutral-500 text-center">No options available</div>
              ) : (
                <>
                  {/* {placeholder && (
                    <button
                      onClick={() => handleSelect('')}
                      className="w-full text-left px-4 py-2.5 text-sm text-neutral-400 hover:bg-neutral-50 transition-colors"
                    >
                      {placeholder}
                    </button>
                  )} */}
                  {options.map((option) => {
                    const isSelected = option.value === value;
                    return (
                      <button
                        key={option.value}
                        onClick={() => handleSelect(option.value)}
                        className={`
                          w-full flex items-center justify-between px-4 py-3 text-sm transition-all
                          border-b border-neutral-200 last:border-0
                          ${isSelected ? 'bg-primary-50 text-primary-700 font-semibold' : 'text-neutral-700 hover:bg-neutral-50'}
                        `}
                      >
                        <span className="truncate">{option.label}</span>
                        {isSelected && <Check size={16} className="text-primary-600 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-2 text-error text-xs font-medium"
        >
          {error}
        </motion.div>
      )}
    </div>
  );
});

Select.displayName = 'Select';

export default Select;

