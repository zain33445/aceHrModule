import React, { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;

export function PDFViewer({ src, title = "Document" }) {
  const [numPages, setNumPages] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const onDocumentLoadSuccess = ({ numPages }) => {
    setNumPages(numPages);
    setCurrentPage(1);
    setLoading(false);
  };

  const onDocumentLoadError = (err) => {
    setError("Failed to load PDF");
    setLoading(false);
    console.error("PDF load error:", err);
  };

  const goToPrevPage = () => setCurrentPage((p) => Math.max(p - 1, 1));
  const goToNextPage = () => setCurrentPage((p) => Math.min(p + 1, numPages));

  return (
    <div className="flex flex-col h-[calc(80vh)] w-1/2 m-auto">
      <style>{`
        .pdf-viewer-scroll::-webkit-scrollbar { width: 6px; }
        .pdf-viewer-scroll::-webkit-scrollbar-track { background: transparent; }
        .pdf-viewer-scroll::-webkit-scrollbar-thumb { background-color: #d1d5db; border-radius: 3px; }
      `}</style>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border border-neutral-500 rounded-t-lg">
        <span className="text-sm font-medium text-neutral-700">{title}</span>
        <div className="flex items-center gap-2">
          {numPages && (
            <span className="text-sm text-neutral-500">
              Page {currentPage} of {numPages}
            </span>
          )}
          <button
            onClick={goToPrevPage}
            disabled={currentPage <= 1}
            className="p-1 rounded hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={goToNextPage}
            disabled={currentPage >= numPages}
            className="p-1 rounded hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* PDF content */}
      <div
        className="pdf-viewer-scroll flex-1 overflow-auto bg-neutral-100 border border-t-0 border-neutral-500 rounded-b-lg flex justify-center"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "#d1d5db transparent",
        }}
      >
        {error ? (
          <div className="flex items-center justify-center h-full text-sm text-red-500">
            {error}
          </div>
        ) : (
          <Document
            file={src}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-full text-sm text-neutral-400 scrollbar-none">
                Loading PDF...
              </div>
            }
          >
            <Page
              pageNumber={currentPage}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              className="shadow-lg scrollbar-none"
            />
          </Document>
        )}
      </div>
    </div>
  );
}
