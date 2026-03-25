import React from 'react';
import { motion } from 'framer-motion';

export const Card = React.forwardRef(({
  children,
  className = '',
  hoverable = false,
  onClick,
  ...props
}, ref) => {
  const baseStyles = 'bg-white rounded-lg border border-neutral-200 shadow-sm overflow-hidden transition-all duration-300';
  const hoverStyles = hoverable ? 'hover:shadow-lg hover:-translate-y-1 cursor-pointer' : '';

  const Component = hoverable ? motion.div : 'div';
  const hoverProps = hoverable ? {
    whileHover: { y: -4 },
    whileTap: { scale: 0.98 },
  } : {};

  return (
    <Component
      ref={ref}
      className={`${baseStyles} ${hoverStyles} ${className}`}
      onClick={onClick}
      {...hoverProps}
      {...props}
    >
      {children}
    </Component>
  );
});

Card.displayName = 'Card';

export const CardHeader = ({ children, className = '' }) => (
  <div className={`px-6 py-4 border-b border-neutral-200 ${className}`}>
    {children}
  </div>
);

export const CardBody = ({ children, className = '' }) => (
  <div className={`px-6 py-4 ${className}`}>
    {children}
  </div>
);

export const CardFooter = ({ children, className = '' }) => (
  <div className={`px-6 py-4 border-t border-neutral-200 bg-neutral-50 ${className}`}>
    {children}
  </div>
);

export default Card;
