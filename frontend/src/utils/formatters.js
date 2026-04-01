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
