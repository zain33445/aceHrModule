import React from 'react';
import { Download } from 'lucide-react';
import { Button } from '../common/Button';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export const PayslipPDFButton = ({ employeeName, salaryData, variant = 'ghost' }) => {
  const generatePDF = () => {
    const doc = new jsPDF();
    const date = new Date(salaryData.date || new Date()).toLocaleString('default', { month: 'long', year: 'numeric' });

    // Header
    doc.setFontSize(22);
    doc.setTextColor(15, 23, 42);
    doc.text('aceHRM Solutions', 14, 20);
    
    doc.setFontSize(14);
    doc.setTextColor(71, 85, 105);
    doc.text(`Salary Payslip - ${date}`, 14, 28);

    // Employee Details
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.text(`Employee Name: ${employeeName}`, 14, 40);
    
    if (salaryData.userId) {
      doc.text(`Employee ID: ${salaryData.userId}`, 14, 46);
    }

    // Salary Table
    const tableData = [
      ['Description', 'Amount (PKR)'],
      ['Base Salary', salaryData.monthly_salary?.toLocaleString() || '0'],
      ['Deductions', `-${salaryData.deductions?.toLocaleString() || '0'}`],
    ];

    if (salaryData.paid_leaves_used > 0) {
      tableData.push(['Paid Leaves Used', `${salaryData.paid_leaves_used} days`]);
    }

    autoTable(doc, {
      startY: 55,
      head: [tableData[0]],
      body: tableData.slice(1),
      theme: 'grid',
      headStyles: { fillColor: [79, 70, 229] }, // Primary color
      styles: { fontSize: 11, cellPadding: 4 },
      columnStyles: {
        1: { halign: 'right' }
      }
    });

    // Totals
    const finalY = doc.lastAutoTable?.finalY || 55;
    
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Net Payable Salary:', 14, finalY + 15);
    doc.text(`PKR ${salaryData.total_salary?.toLocaleString() || '0'}`, 140, finalY + 15, { align: 'right' });

    // Footer
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text('This is a computer-generated document and requires no signature.', 14, 280);

    // Save
    doc.save(`Payslip_${employeeName.replace(/\s+/g, '_')}_${date}.pdf`);
  };

  return (
    <Button variant={variant} size="sm" onClick={generatePDF} className="flex items-center gap-2">
      <Download size={16} />
      Download PDF
    </Button>
  );
};
