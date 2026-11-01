Humarains: all changes from this session
========================================

A. Blog spacing + four new posts
  1. Copy public/typography.css over your existing public/typography.css
     (original file plus new blog styles at the end).
  2. Copy public/blog-more.js into your public/ folder.
  3. In public/blog.html add this line just before </body> (blog-more.js also fixes a bug in blog.html's openPost that wrapped the "Back to the blog" link inside the signup button link):
       <script src="blog-more.js"></script>

B. Practice enquiry fix (onboarding step 4)
  From the repo root run:
       node apply-practice-enquiry-fix.js
  It edits src/services/leads/engine.js and src/routes/leads.js (backups saved
  as .bak) and changes nothing if any edit does not match exactly once.
  Restart the server afterwards.

Then commit and deploy.
