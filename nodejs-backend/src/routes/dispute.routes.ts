import { Router } from 'express';
import { DisputeService } from '../services/dispute.service';
import prisma from '../prisma';

const router = Router();

// Get all disputes (including pending and resolved)
router.get('/', async (req, res) => {
  try {
    const disputes = await prisma.dispute.findMany({
      include: {
        requester: {
          select: {
            id: true,
            name: true
          }
        },
        approver: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date_of_req: 'desc'
      }
    });
    res.json(disputes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch disputes" });
  }
});

// Get disputes requested by a specific user
router.get('/requested/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const disputes = await prisma.dispute.findMany({
      where: { req_by: userId },
      include: {
        requester: {
          select: {
            id: true,
            name: true
          }
        },
        approver: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date_of_req: 'desc'
      }
    });
    res.json(disputes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user disputes" });
  }
});

// Get disputes for a specific user with pagination and filters
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate, category, page = 1, limit = 20 } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const where: any = { req_by: userId };
  
  if (startDate && endDate) {
    where.dispute_date = {
      gte: new Date(startDate as string),
      lte: new Date(endDate as string)
    };
  }

  if (category && category !== 'all') {
    where.category = category;
  }

  try {
    const [disputes, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        include: {
          requester: {
            select: {
              id: true,
              name: true
            }
          },
          approver: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: {
          date_of_req: 'desc'
        },
        skip,
        take
      }),
      prisma.dispute.count({ where })
    ]);

    res.json({
      records: disputes,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user disputes" });
  }
});

// Get disputes approved by a specific user
router.get('/approved/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const disputes = await prisma.dispute.findMany({
      where: { approved_by: userId },
      include: {
        requester: {
          select: {
            id: true,
            name: true
          }
        },
        approver: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: {
        date_of_req: 'desc'
      }
    });
    res.json(disputes);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch approved disputes" });
  }
});

// Get all pending disputes (for admin) - returns all disputes for filtering
router.get('/pending', async (req, res) => {
  try {
    const disputes = await DisputeService.getPendingDisputes();
    res.json(disputes);
  } catch (error) {
    console.error('Error fetching pending disputes:', error);
    res.status(500).json({ error: "Failed to fetch pending disputes" });
  }
});

// Create a dispute
router.post('/', async (req, res) => {
  const { user_id, req_by, description, dispute_date, category, date_of_req, status } = req.body;
  try {
    const userId = user_id || req_by;
    const disputeCategory = category || 'other';

    const dispute = await DisputeService.createDispute({
      user_id: userId,
      dispute_date: new Date(dispute_date),
      dispute_category: disputeCategory,
      description,
      status: status || 'pending'
    });

    // Notify all admin users about the new dispute
    const admins = await prisma.user.findMany({
      where: { role: 'admin' },
      select: { id: true }
    });

    const disputeDateStr = new Date(dispute_date).toLocaleDateString();
    const employeeName = dispute.requester?.name || `Employee #${userId}`;
    
    for (const admin of admins) {
      await prisma.notification.create({
        data: {
          user_id: admin.id,
          type: 'new_dispute',
          message: `${employeeName} filed a new ${disputeCategory} dispute for ${disputeDateStr}.`
        }
      });
    }

    res.json(dispute);
  } catch (error) {
    console.error('Error creating dispute:', error);
    res.status(500).json({ error: "Failed to create dispute" });
  }
});

// Update dispute status (approve/reject)
router.put('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { approved_by, remarks, date_of_approve, status } = req.body;
  try {
    const dispute = await prisma.dispute.update({
      where: { id: parseInt(id) },
      data: {
        approved_by,
        remarks,
        date_of_approve: date_of_approve ? new Date(date_of_approve) : new Date(),
        status
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true
          }
        },
        approver: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    res.json({ message: "Dispute status updated", dispute });
  } catch (error) {
    res.status(500).json({ error: "Failed to update dispute status" });
  }
});

// Update a dispute
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { description, remarks, status } = req.body;
  try {
    const dispute = await prisma.dispute.update({
      where: { id: parseInt(id) },
      data: {
        description,
        remarks,
        status
      },
      include: {
        requester: {
          select: {
            id: true,
            name: true
          }
        },
        approver: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    res.json({ message: "Dispute updated", dispute });
  } catch (error) {
    res.status(500).json({ error: "Failed to update dispute" });
  }
});

// Approve a dispute
router.put('/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { remarks, approved_by } = req.body;
  try {
    const dispute = await DisputeService.approveDispute(
      parseInt(id),
      approved_by || 'admin',
      remarks || ''
    );

    res.json(dispute);
  } catch (error) {
    console.error('Error approving dispute:', error);
    res.status(500).json({ error: "Failed to approve dispute" });
  }
});

// Reject a dispute
router.put('/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { remarks, approved_by } = req.body;
  try {
    const dispute = await DisputeService.rejectDispute(
      parseInt(id),
      approved_by || 'admin',
      remarks || ''
    );

    res.json(dispute);
  } catch (error) {
    console.error('Error rejecting dispute:', error);
    res.status(500).json({ error: "Failed to reject dispute" });
  }
});

// Delete a dispute
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.dispute.delete({
      where: { id: parseInt(id) }
    });
    res.json({ message: "Dispute deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete dispute" });
  }
});

export default router;