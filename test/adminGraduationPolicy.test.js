const test = require("node:test");
const assert = require("node:assert/strict");

const {
  areAllRequiredDocumentsFulfilled,
  areAllRequiredDocumentsFilled,
  mapSubmissionRow,
  graduateStudentDirectly,
  REQUIRED_COMMON_REVIEW_FIELD_KEYS
} = require("../utils/graduationSubmissions");

test("areAllRequiredDocumentsFulfilled returns false for empty or invalid input", () => {
  assert.equal(areAllRequiredDocumentsFulfilled(null), false);
  assert.equal(areAllRequiredDocumentsFulfilled([]), false);
  assert.equal(areAllRequiredDocumentsFulfilled(undefined), false);
});

test("areAllRequiredDocumentsFulfilled returns false when common fields are missing", () => {
  const projectRows = [
    {
      position_label: "Anggota",
      report_url: "https://example.com/report",
      // missing manualBookUrl and productPhotoFolderUrl
      demo_video_url: "https://example.com/demo",
      field_reviews: {
        reportUrl: { status: "accepted" },
        demoVideoUrl: { status: "accepted" }
      }
    }
  ];

  assert.equal(areAllRequiredDocumentsFulfilled(projectRows), false);
});

test("areAllRequiredDocumentsFulfilled returns false when a field is provided but not accepted", () => {
  const projectRows = [
    {
      position_label: "Anggota",
      report_url: "https://example.com/report",
      manual_book_url: "https://example.com/manual",
      product_photo_folder_url: "https://example.com/photos",
      demo_video_url: "https://example.com/demo",
      field_reviews: {
        reportUrl: { status: "accepted" },
        manualBookUrl: { status: "rejected", reason: "Revisi cover" },
        productPhotoFolderUrl: { status: "accepted" },
        demoVideoUrl: { status: "accepted" }
      }
    }
  ];

  assert.equal(areAllRequiredDocumentsFulfilled(projectRows), false);
});

test("areAllRequiredDocumentsFulfilled returns false when role-specific fields are missing for Software Engineer", () => {
  const projectRows = [
    {
      position_label: "Software Engineer",
      report_url: "https://example.com/report",
      manual_book_url: "https://example.com/manual",
      product_photo_folder_url: "https://example.com/photos",
      demo_video_url: "https://example.com/demo",
      // missing github_url and deployed_url
      field_reviews: {
        reportUrl: { status: "accepted" },
        manualBookUrl: { status: "accepted" },
        productPhotoFolderUrl: { status: "accepted" },
        demoVideoUrl: { status: "accepted" }
      }
    }
  ];

  assert.equal(areAllRequiredDocumentsFulfilled(projectRows), false);
});

test("areAllRequiredDocumentsFulfilled returns true when all common and role-specific fields are accepted", () => {
  const projectRows = [
    {
      position_label: "Software Engineer",
      report_url: "https://example.com/report",
      manual_book_url: "https://example.com/manual",
      product_photo_folder_url: "https://example.com/photos",
      demo_video_url: "https://example.com/demo",
      repository_url: "https://github.com/org/repo",
      deployed_url: "https://demo.example.com",
      field_reviews: {
        reportUrl: { status: "accepted" },
        manualBookUrl: { status: "accepted" },
        productPhotoFolderUrl: { status: "accepted" },
        demoVideoUrl: { status: "accepted" },
        repositoryUrl: { status: "accepted" },
        deployedUrl: { status: "accepted" }
      }
    }
  ];

  assert.equal(areAllRequiredDocumentsFulfilled(projectRows), true);
});

test("areAllRequiredDocumentsFilled checks presence of URLs regardless of review status", () => {
  const incompleteProjects = [
    {
      position_label: "Anggota",
      report_url: "https://example.com/report"
      // missing others
    }
  ];
  assert.equal(areAllRequiredDocumentsFilled(incompleteProjects), false);

  const completeProjects = [
    {
      position_label: "Anggota",
      report_url: "https://example.com/report",
      manual_book_url: "https://example.com/manual",
      product_photo_folder_url: "https://example.com/photos",
      demo_video_url: "https://example.com/demo"
    }
  ];
  assert.equal(areAllRequiredDocumentsFilled(completeProjects), true);
});

test("mapSubmissionRow preserves certificateEligible boolean", () => {
  assert.equal(mapSubmissionRow(null), null);

  const eligibleRow = {
    id: "SUB-1",
    student_id: "STU-1",
    user_id: "USR-1",
    status: "Valid",
    certificate_eligible: true
  };
  assert.equal(mapSubmissionRow(eligibleRow).certificateEligible, true);

  const ineligibleRow = {
    id: "SUB-2",
    student_id: "STU-2",
    user_id: "USR-2",
    status: "Valid",
    certificate_eligible: false
  };
  assert.equal(mapSubmissionRow(ineligibleRow).certificateEligible, false);
});

test("graduateStudentDirectly graduates an active student with certificate withholding on dispensation", async () => {
  const executedQueries = [];

  const mockClient = {
    async query(text, params) {
      executedQueries.push({ text: text.trim(), params });

      // 1. SELECT student
      if (text.includes("SELECT s.*, u.name AS student_name")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "MHS-001",
              user_id: "USR-001",
              name: "Budi Santoso",
              student_name: "Budi Santoso",
              status: "Aktif"
            }
          ]
        };
      }

      // 2. Existing graduation submission query
      if (text.includes("SELECT id, status, graduation_allowed_at, certificate_eligible")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "GRD-100",
              status: "Draft",
              graduation_allowed_at: null,
              certificate_eligible: true
            }
          ]
        };
      }

      // 3. Other queries (UPDATE students, UPDATE research_memberships, UPDATE graduation_submissions, audit_logs)
      return { rowCount: 1, rows: [] };
    }
  };

  const result = await graduateStudentDirectly({
    studentId: "MHS-001",
    operatorUserId: "OP-01",
    note: "Dispensasi kelulusan tanpa berkas lengkap",
    certificateEligible: false,
    client: mockClient
  });

  assert.equal(result.studentId, "MHS-001");
  assert.equal(result.certificateEligible, false);

  // Check that students table was updated to Alumni
  const studentUpdate = executedQueries.find((q) => q.text.startsWith("UPDATE students"));
  assert.ok(studentUpdate, "UPDATE students query should be executed");
  assert.ok(studentUpdate.text.includes("SET status = 'Alumni'"));

  // Check that research memberships were updated
  const membershipUpdate = executedQueries.find((q) => q.text.startsWith("UPDATE research_memberships"));
  assert.ok(membershipUpdate, "UPDATE research_memberships query should be executed");
  assert.ok(membershipUpdate.text.includes("SET peran = 'Alumni'"));

  // Check that graduation submission was updated with certificate_eligible = false
  const submissionUpdate = executedQueries.find((q) => q.text.startsWith("UPDATE graduation_submissions"));
  assert.ok(submissionUpdate, "UPDATE graduation_submissions should be executed");
  assert.equal(submissionUpdate.params[3], false, "certificate_eligible parameter should be false");
});

test("graduateStudentDirectly rejects graduating an already Alumni student", async () => {
  const mockClient = {
    async query(text) {
      if (text.includes("SELECT s.*, u.name AS student_name")) {
        return {
          rowCount: 1,
          rows: [{ id: "MHS-002", user_id: "USR-002", status: "Alumni" }]
        };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  await assert.rejects(
    async () => {
      await graduateStudentDirectly({
        studentId: "MHS-002",
        operatorUserId: "OP-01",
        client: mockClient
      });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /sudah berstatus Alumni/);
      return true;
    }
  );
});
