/**
 * Formats a 24-hour time string (HH:mm) to 12-hour format with AM/PM
 * @param {string} timeStr - Time string in HH:mm format
 * @returns {string} - Formatted time string (e.g., 09:30 AM)
 */
export const formatTime12h = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return '-';
  
  const [hours, minutes] = timeStr.split(':');
  let h = parseInt(hours, 10);
  const m = minutes || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  
  h = h % 12;
  h = h ? h : 12; // the hour '0' should be '12'
  
  return `${h.toString().padStart(2, '0')}:${m} ${ampm}`;
};

/**
 * Formats a Date object to YYYY-MM-DD string in local time
 * @param {Date} date - Date object
 * @returns {string} - Formatted date string (e.g., 2026-04-01)
 */
export const formatDateLocal = (date) => {
  if (!date || !(date instanceof Date)) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};
