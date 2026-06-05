import prisma from '../prisma';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

const MAX_RETRIES = 3;

/**
 * Worker to process OutboxEvents idempotently
 */
export async function processOutboxEvents() {
  try {
    // 1. Claim pending events
    const processingId = uuidv4();
    
    // Find a batch of PENDING events
    const pendingEvents = await prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      take: 50,
      orderBy: { created_at: 'asc' }
    });

    if (pendingEvents.length === 0) return;

    console.log(`[Outbox Worker] Found ${pendingEvents.length} pending events. Claiming with processing_id: ${processingId}`);

    // We claim them by updating status to PROCESSING and assigning our ID.
    // In a multi-instance setup, we might use updateMany with status: PENDING
    // but here we process sequentially for simplicity.
    for (const event of pendingEvents) {
      const claimed = await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: 'PENDING' },
        data: { status: 'PROCESSING', processing_id: processingId }
      });

      if (claimed.count === 0) continue; // Someone else grabbed it

      try {
        await processEvent(event);
        
        // Mark Completed
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'COMPLETED', processed_at: new Date() }
        });
        
        console.log(`[Outbox Worker] Event ${event.id} processed successfully.`);
      } catch (error: any) {
        console.error(`[Outbox Worker] Event ${event.id} failed:`, error.message);
        
        // Handle Retry/Failure
        const newRetryCount = event.retry_count + 1;
        const newStatus = newRetryCount > MAX_RETRIES ? 'FAILED' : 'PENDING';
        
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { 
            status: newStatus,
            retry_count: newRetryCount,
            error: error.message || 'Unknown error',
            processing_id: null // Release claim
          }
        });
      }
    }
  } catch (error) {
    console.error('[Outbox Worker] Error in worker loop:', error);
  }
}

async function processEvent(event: any) {
  if (event.type === 'SYNC_ATTENDANCE') {
    const { user_id, start_date, end_date, is_half_day } = event.payload as any;
    
    // Idempotent UPSERT into AttendanceRecord
    // Generate dates between start and end
    const start = new Date(start_date);
    const end = new Date(end_date);
    const datesToSync = [];
    
    let current = new Date(start);
    while (current <= end) {
      // Skip weekends if that's the policy, assuming simple loop for now
      datesToSync.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    for (const date of datesToSync) {
      // UPSERT attendance
      // Assuming user_id and date uniquely identify a record. If not, findFirst then create/update.
      const startOfDay = new Date(date);
      startOfDay.setHours(0,0,0,0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23,59,59,999);

      const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
          user_id,
          date: { gte: startOfDay, lte: endOfDay }
        }
      });

      if (existingRecord) {
        await prisma.attendanceRecord.update({
          where: { id: existingRecord.id },
          data: { status: 'leave', is_halfday: is_half_day }
        });
      } else {
        await prisma.attendanceRecord.create({
          data: {
            user_id,
            date: startOfDay,
            status: 'leave',
            is_halfday: is_half_day
          }
        });
      }
    }
  } else if (event.type === 'DEVICE_CREATE_USER') {
    const { employee_id, name } = event.payload as any;
    try {
      await axios.post('http://localhost:8000/create-user', {
        employee_id,
        name
      });
      console.log(`[Device Sync] Successfully created user ${employee_id} from queue.`);
    } catch (error: any) {
      // Re-throw so the worker marks it as FAILED/PENDING for retry
      throw new Error(`Device sync failed: ${error.message}`);
    }
  } else {
    throw new Error(`Unknown event type: ${event.type}`);
  }
}

// Optional: Recovery job for stuck PROCESSING events
export async function recoverStuckEvents() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const stuck = await prisma.outboxEvent.updateMany({
    where: { status: 'PROCESSING', updated_at: { lt: fiveMinutesAgo } },
    data: { status: 'PENDING', processing_id: null }
  });
  if (stuck.count > 0) {
    console.log(`[Outbox Worker] Recovered ${stuck.count} stuck events.`);
  }
}
