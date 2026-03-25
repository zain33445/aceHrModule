import React from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown } from 'lucide-react';
import Card from '../common/Card';

export const StatCard = ({
  title,
  value,
  icon: Icon,
  trend,
  trendLabel,
  variant = 'default',
  onClick,
  className = '',
}) => {
  const variants = {
    default: 'bg-white',
    primary: 'bg-primary-50 border-primary-200',
    success: 'bg-success/5 border-success/20',
    warning: 'bg-warning/5 border-warning/20',
    error: 'bg-error/5 border-error/20',
  };

  const trendColor = trend > 0 ? 'text-success' : 'text-error';
  const TrendIcon = trend > 0 ? TrendingUp : TrendingDown;

  return (
    <motion.div
      whileHover={{ scale: 1.02, translateY: -4 }}
      whileTap={{ scale: 0.98 }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card
        hoverable
        onClick={onClick}
        className={`${variants[variant]} ${className}`}
      >
        <div className="flex items-start justify-between gap-4 p-6">
          {/* Left: Values */}
          <div className="flex-1">
            <p className="text-sm font-medium text-neutral-600">{title}</p>
            <p className="text-3xl font-bold text-neutral-900 mt-2">{value}</p>

            {/* Trend */}
            {trend !== undefined && (
              <div className={`flex items-center gap-1 mt-3 ${trendColor} text-sm font-medium`}>
                <TrendIcon size={16} />
                <span>{Math.abs(trend)}%</span>
                {trendLabel && <span className="text-neutral-600 ml-1">{trendLabel}</span>}
              </div>
            )}
          </div>

          {/* Right: Icon */}
          {Icon && (
            <div className="flex-shrink-0">
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${
                variant === 'default'
                  ? 'bg-primary-100'
                  : `bg-${variant}-100`
              }`}>
                <Icon
                  size={24}
                  className={
                    variant === 'default'
                      ? 'text-primary-600'
                      : `text-${variant}`
                  }
                />
              </div>
            </div>
          )}
        </div>
      </Card>
    </motion.div>
  );
};

export default StatCard;
