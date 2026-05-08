import { Router } from 'express';
import { DisputeService } from '../services/dispute.service';
import prisma from '../prisma';

const router = Router();

// Get all disputes (Admin View)
router.get('/', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  try {
    const result = await DisputeService.getAdminDisputes(Number(page), Number(limit));
    res.json({
      success: true,
      message: "Disputes fetched successfully",
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch disputes" });
  }
});

// Get team disputes (Lead View)
router.get('/team', async (req, res) => {
  const { leadId, page = 1, limit = 20 } = req.query;
  if (!leadId) return res.status(400).json({ success: false, error: "leadId is required" });
  
  try {
    const result = await DisputeService.getTeamDisputes(leadId as string, Number(page), Number(limit));
    res.json({
      success: true,
      message: "Team disputes fetched successfully",
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch team disputes" });
  }
});

// Get disputes for a specific user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const disputes = await DisputeService.getUserDisputes(userId);
    res.json({
      success: true,
      message: "User disputes fetched successfully",
      data: disputes
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch user disputes" });
  }
});

// Create a dispute
router.post('/', async (req, res) => {
  const { user_id, req_by, description, dispute_date, category } = req.body;
  try {
    const userId = user_id || req_by;
    const dispute = await DisputeService.createDispute({
      user_id: userId,
      dispute_date: new Date(dispute_date),
      category,
      description
    });

    // Notify Leads of the department
    const employee = await prisma.user.findUnique({
      where: { id: userId },
      select: { department_id: true, name: true }
    });

    if (employee?.department_id) {
      const dept = await prisma.department.findUnique({
        where: { id: employee.department_id },
        select: { lead_id: true }
      });

      if (dept?.lead_id) {
        await prisma.notification.create({
          data: {
            user_id: dept.lead_id,
            type: 'new_dispute',
            message: `${employee.name} filed a new dispute for ${new Date(dispute_date).toLocaleDateString()}.`
          }
        });
      }
    }

    res.json({ success: true, message: "Dispute created successfully", data: dispute });
  } catch (error) {
    console.error('Error creating dispute:', error);
    res.status(500).json({ success: false, error: "Failed to create dispute" });
  }
});

// Lead Approval Action
router.put('/:id/lead-approval', async (req, res) => {
  const { id } = req.params;
  const { lead_id, action, remarks } = req.body;
  
  try {
    let dispute;
    if (action === 'approve') {
      dispute = await DisputeService.leadApprove(Number(id), lead_id, remarks);
    } else {
      dispute = await DisputeService.leadReject(Number(id), lead_id, remarks);
    }
    res.json({ success: true, message: `Dispute ${action}d by Lead`, data: dispute });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Approval Action
router.put('/:id/admin-approval', async (req, res) => {
  const { id } = req.params;
  const { admin_id, action, remarks } = req.body;
  
  try {
    let dispute;
    if (action === 'approve') {
      dispute = await DisputeService.adminApprove(Number(id), admin_id, remarks);
    } else {
      dispute = await DisputeService.adminReject(Number(id), admin_id, remarks);
    }
    res.json({ success: true, message: `Dispute ${action}d by Admin`, data: dispute });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Soft Delete
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.dispute.update({
      where: { id: Number(id) },
      data: { is_deleted: true, deleted_at: new Date() }
    });
    res.json({ success: true, message: "Dispute deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to delete dispute" });
  }
});

export default router;