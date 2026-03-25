import React from 'react';
import { User } from 'lucide-react';

export const Avatar = ({
  src,
  name,
  size = 'md',
  onClick,
  className = '',
  ...props
}) => {
  const sizes = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-12 h-12 text-base',
    xl: 'w-16 h-16 text-lg',
  };

  const initials = name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U';

  return (
    <div
      className={`${sizes[size]} rounded-full inline-flex items-center justify-center font-semibold cursor-pointer transition-transform hover:scale-105 ${
        src
          ? 'bg-gray-200'
          : 'bg-primary-100 text-primary-700'
      } ${className}`}
      onClick={onClick}
      title={name}
      {...props}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className="w-full h-full rounded-full object-cover"
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
};

export default Avatar;
