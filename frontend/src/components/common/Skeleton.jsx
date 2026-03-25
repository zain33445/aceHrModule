import React from 'react';

export const Skeleton = ({
  className = '',
  variant = 'text',
  count = 1,
  ...props
}) => {
  const variants = {
    text: 'h-4 rounded w-full',
    heading: 'h-8 rounded w-3/4',
    avatar: 'h-12 w-12 rounded-full',
    card: 'h-40 rounded-lg w-full',
  };

  const baseStyles = 'bg-gradient-to-r from-neutral-100 via-neutral-50 to-neutral-100 animate-shimmer bg-[length:200%_100%]';

  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`${baseStyles} ${variants[variant]} ${className}`}
          {...props}
        />
      ))}
    </>
  );
};

export default Skeleton;
