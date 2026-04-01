import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import Button from './Button';

export const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeButton = true,
}) => {
  const sizes = {
    sm: 'max-w-sm',
    md: 'md:w-1/2 w-[90%]',
    lg: 'max-w-5xl',
    xl: 'max-w-6xl',
    '2xl': 'max-w-7xl',
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-40"
          />

          {/* Modal Container */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className={`bg-white rounded-lg shadow-2xl relative w-full ${sizes[size]}`}
            >
            {/* Header */}
            {(title || closeButton) && (
              <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
                {title && <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>}
                <div className="flex-1" />
                {closeButton && (
                  <button
                    onClick={onClose}
                    className="p-1 hover:bg-neutral-100 rounded-md transition-colors"
                  >
                    <X size={20} />
                  </button>
                )}
              </div>
            )}

            {/* Content */}
            <div className="px-6 py-4 max-h-96 overflow-y-auto">
              {children}
            </div>

            {/* Footer */}
            {footer && (
              <div className="px-6 py-4 border-t border-neutral-200 bg-neutral-50 flex gap-3 justify-end">
                {footer}
              </div>
            )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
};

export default Modal;
