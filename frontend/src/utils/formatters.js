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
 * Calculates working hours from check-in and check-out times.
 * If check-out is missing, uses current Karachi time (live, changes on refresh).
 * @param {string} checkIn - Time string in HH:mm format
 * @param {string} checkOut - Time string in HH:mm format (optional)
 * @returns {string|null} - Formatted string like "8h 15m" or null
 */
export const calculateWorkingHours = (checkIn, checkOut) => {
  if (!checkIn || typeof checkIn !== 'string') return null;

  const parse = (str) => {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
  };

  const startMin = parse(checkIn);

  let endMin;
  if (checkOut && typeof checkOut === 'string') {
    endMin = parse(checkOut);
  } else {
    const now = new Date();
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    endMin = (utcMin + 5 * 60) % (24 * 60); // Karachi UTC+5
  }

  let diff = endMin - startMin;
  if (diff < 0) diff += 24 * 60; // midnight crossover

  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return `${h}h ${m}m`;
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
