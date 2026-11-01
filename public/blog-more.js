/* Extra blog posts. In public/blog.html add, just before </body>:
   <script src="blog-more.js"></script>
   Adds new cards to the top of the grid and registers the posts with openPost(). */
(function () {
  var CTA = function (t) { return '<div class="post-cta"><p>' + t + '</p><a href="signup.html">Get started free</a></div>'; };
  var NEW = [
    {
      slug: 'blog-what-to-automate-first', cat: 'Operations', min: 6, date: '2026-11-01', dateLabel: 'November 1, 2026',
      title: 'What to Automate First: A Practical Order of Operations for a Small Service Business',
      desc: 'Automation works best when it arrives in the right order. Here is a simple sequence for a service business: what to hand over first, what to keep human, and what to leave for later.',
      cta: 'Humarains starts with the highest-leverage steps, instant replies and follow-up, so you see results in the first week.',
      body: '<p>Most owners who get stuck on automation are not short on tools. They are short on a sequence. Switching everything on at once creates noise, and switching on the wrong thing first creates mistakes a customer can see. Order matters more than ambition.</p>' +
        '<h2>Start where the damage is quietest and the gain is largest</h2>' +
        '<ul><li><strong>First reply.</strong> Every enquiry needs a fast, specific answer. It is repetitive, it is time-sensitive, and it is the step most often delayed by a busy day.</li>' +
        '<li><strong>Follow-up.</strong> Leads who go quiet need a second and third touch. This is the step people forget, and the easiest one to run on a schedule.</li>' +
        '<li><strong>Booking.</strong> Once a lead says yes, getting them onto the calendar without back-and-forth removes the last gap between interest and a confirmed job.</li></ul>' +
        '<h2>Keep a human on the high-stakes moments</h2>' +
        '<p>Large quotes, complaints, and unusual requests deserve a person. A simple approval step lets automation draft the reply while someone checks it before it goes out. You can loosen that gate as you see the results.</p>' +
        '<blockquote>Automate the work that is repetitive and urgent. Keep people on the work that is personal and rare.</blockquote>' +
        '<h2>What can wait</h2>' +
        '<p>Reporting, lead scoring, and reactivation campaigns are valuable, but they build on clean, consistent lead data. Get the first three steps running reliably, then layer these on.</p>'
    },
    {
      slug: 'blog-reopen-old-leads', cat: 'Follow-up', min: 5, date: '2026-11-01', dateLabel: 'November 1, 2026',
      title: 'Quiet Leads Are Not Dead Leads: How to Reopen a Conversation Without Being Pushy',
      desc: 'Most businesses give up on a lead after a message or two. Here is how to reopen an old conversation in a way that feels helpful rather than desperate.',
      cta: 'Humarains keeps every past conversation on record, so reopening an old lead starts with full context.',
      body: '<p>Somewhere in your inbox is a list of people who asked for a quote, got one, and then went silent. Most of them did not say no. They got busy, waited on someone else, or simply forgot. Treating silence as a decision leaves real revenue unclaimed.</p>' +
        '<h2>Why reopening works</h2>' +
        '<ul><li>Timing changes. A lead who was not ready in spring may need the job done in autumn.</li>' +
        '<li>They already know you. The hardest part, first contact, is done.</li>' +
        '<li>You have context: what they asked for, what you quoted, and what was left open.</li></ul>' +
        '<h2>How to do it without sounding pushy</h2>' +
        '<p>Lead with something useful, not a reminder. Mention the specific job they asked about, add one new piece of information such as an updated availability window or a seasonal change, and make replying easy with a single question. A message that gives them something is received very differently from one that only asks.</p>' +
        '<blockquote>The best reopening message sounds like you remembered them, not like you ran a list.</blockquote>' +
        '<h2>Know when to stop</h2>' +
        '<p>One or two reopening attempts, spaced weeks apart, is respectful. After that, let the conversation rest and move the contact into a long-term list rather than continuing to chase.</p>'
    },
    {
      slug: 'blog-electricians-site-visit-booking', cat: 'Trades', min: 5, date: '2026-11-01', dateLabel: 'November 1, 2026',
      title: 'Electricians and Contractors: The Site-Visit Booking Is the Real Conversion',
      desc: 'For trades that quote after seeing the job, the enquiry is not the finish line. The booked site visit is. Here is how to get more enquiries to that step.',
      cta: 'Humarains asks the right questions up front and books site visits straight into your calendar.',
      body: '<p>For electricians, builders, and other contractors, a price usually cannot be given until someone has seen the job. That makes the site visit the real conversion point: the moment an enquiry becomes a commitment of time on both sides.</p>' +
        '<h2>Where enquiries stall before the visit</h2>' +
        '<ul><li>The first reply is slow, so the customer books a visit with someone else.</li>' +
        '<li>Details are missing, so the visit gets delayed while the details are chased.</li>' +
        '<li>Scheduling takes several messages, and momentum fades between each one.</li></ul>' +
        '<h2>What a smooth path looks like</h2>' +
        '<p>A fast first reply that asks two or three focused questions, such as the type of work, the location, and the timing, gives you enough to prepare. Offering real available slots in the same message turns the conversation into a booking rather than a discussion.</p>' +
        '<blockquote>Customers do not choose the cheapest quote. They choose the first business that made the next step easy.</blockquote>' +
        '<h2>Protecting your day</h2>' +
        '<p>Because visits are booked against a live calendar, you avoid double-booking and you can group visits by area. A reminder the day before reduces wasted trips.</p>'
    },
    {
      slug: 'blog-five-minute-response-standard', cat: 'Lead response', min: 5, date: '2026-11-01', dateLabel: 'November 1, 2026',
      title: 'The Five-Minute Standard: A Simple Rule for Lead Response',
      desc: 'Fast is vague. A clear standard is not. Here is how to set a response target your whole business can follow, and how to know whether you are meeting it.',
      cta: 'Humarains replies in minutes and flags any lead that is waiting longer than your target.',
      body: '<p>Saying that you reply quickly is not the same as having a standard. Without a number, speed becomes whatever the day allows, and busy days are when it matters most. A clear target gives everyone the same definition of good.</p>' +
        '<h2>Why a number helps</h2>' +
        '<ul><li>It is measurable. You can see how often you meet it and where you miss.</li>' +
        '<li>It is shareable. Everyone on the team knows what fast means.</li>' +
        '<li>It exposes gaps. Evenings, weekends, and peak weeks show up quickly.</li></ul>' +
        '<h2>Choosing your target</h2>' +
        '<p>Pick a first-reply goal you can meet on your worst day, not your best one. Five minutes is a strong aim for most enquiries. If that is not realistic by hand, that gap is the signal to automate the first reply while people handle the conversation that follows.</p>' +
        '<blockquote>A standard you only meet on quiet days is a hope, not a standard.</blockquote>' +
        '<h2>Track the slowest replies</h2>' +
        '<p>Averages hide problems. Look at the longest-waiting lead right now and the slowest tenth of replies. Those are the leads you are most likely losing.</p>'
    }
  ];

  var grid = document.getElementById('blog-grid');
  if (!grid || typeof ARTICLES === 'undefined') return;

  // Fix for blog.html's openPost(): its regex turned EVERY "</a>" that is followed by a tag into "</span>", including the
  // "Get started free" button's closing tag. That left the button open, so "Back to the blog" ended up inside the signup link.
  // This version converts only the back-link, and uses replaceState when opening a post straight from a ?post= URL.
  window.openPost = function (slug, replace) {
    var a = articleMap[slug];
    if (!a) return;
    var inner = a.article_inner.replace(/<a class="back-link" href="blog\.html">([\s\S]*?)<\/a>/g,
      '<span class="back-link" onclick="goBack()">$1</span>');
    document.getElementById('post-content').innerHTML = inner;
    document.getElementById('view-index').classList.add('hidden');
    document.getElementById('view-post').classList.remove('hidden');
    setMeta(a);
    history[replace ? 'replaceState' : 'pushState']({ slug: slug }, a.title, '?post=' + slug.replace('blog-', ''));
    window.scrollTo(0, 0);
  };

  NEW.slice().reverse().forEach(function (n) {
    if (articleMap[n.slug]) return;
    var meta = n.cat + ' \u00b7 ' + n.min + ' min read \u00b7 ' + n.dateLabel;
    var a = {
      slug: n.slug, title: n.title, desc: n.desc, date: n.date, post_meta: meta,
      article_inner: '<div class="post-meta">' + meta + '</div><h1>' + n.title + '</h1>' + n.body + CTA(n.cta) +
        '<a class="back-link" href="blog.html">\u2190 Back to the blog</a>'
    };
    ARTICLES.push(a);
    articleMap[a.slug] = a;
    var card = document.createElement('div');
    card.className = 'blog-card';
    card.setAttribute('data-slug', n.slug);
    card.setAttribute('onclick', 'openPost(this.dataset.slug)');
    card.innerHTML = '<div class="blog-card-meta"><span>' + n.cat + '</span><span>\u00b7</span><span>' + n.min + ' min read</span></div>' +
      '<h2>' + n.title + '</h2><p>' + n.desc + '</p><span class="read-more">Read the post \u2192</span>';
    grid.insertBefore(card, grid.firstChild);
  });

  // Deep links to the new posts (?post=...) are resolved after this file loads.
  var p = new URLSearchParams(location.search).get('post');
  if (p) { var s = p.indexOf('blog-') === 0 ? p : 'blog-' + p; if (articleMap[s]) openPost(s, true); }
})();
