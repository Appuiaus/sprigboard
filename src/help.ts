// The in-app Help guide: plain-language how-tos for Jamie, one section per area.

import { esc } from "./lib";

const SECTIONS: [string, string, string][] = [
  ["start", "Getting started", `
    <ol>
      <li><b>Settings:</b> add your business name, ABN, email and payment details, and set a price for each job size.</li>
      <li><b>Clients:</b> add Shane's business, with the copyright line and logo he gives you.</li>
      <li><b>Plant library:</b> add your plant graphics, or import a list of names from a CSV file first and add the graphics later.</li>
      <li><b>Account:</b> add a passkey (fingerprint, face or phone) so you can sign in without waiting for an email.</li>
      <li><b>Jobs:</b> press <b>+</b> to create your first job.</li>
    </ol>
    <p>The checklist at the top of the Jobs page tracks these for you. You can hide it, and switch it back on in Settings.</p>`],
  ["jobs", "Jobs", `
    <p>Every drawing is a job with its own number (J-0001, J-0002…). Open a job to see everything about it: the client, size, plans, checklist, time and invoices.</p>
    <ul>
      <li><b>Search and filters</b> on the Jobs page find a job by number, project, address or client, or by status. Done jobs are hidden until you show them.</li>
      <li><b>Status</b> moves a job along (New, Drawing, Sent to client, Invoiced, Done). You can rename these in Settings.</li>
      <li><b>Duplicate</b> (the copy button on a job) starts a new job with the same client, size and address, and can copy the checklist too. That's handy for repeat work.</li>
    </ul>`],
  ["plans", "Plans and the checklist", `
    <p>Upload the plan Shane sends (PDF, JPEG or PNG) with the upload button on the job. Then press the sparkle button and Claude reads the plan and lists:</p>
    <ul><li>plants (with pot sizes and quantities when shown),</li><li>street names,</li><li>dimensions,</li><li>other markings, and notes.</li></ul>
    <p>The list is a <b>draft</b>: check each item against the plan, and tick it off as you draw it. Edit or delete anything Claude got wrong, or add items with <b>+</b>. Reading the plan again only replaces unticked items Claude found; anything you added or ticked stays.</p>
    <p>Want Claude to do something differently, like ignore irrigation notes? Add it under Settings → Plans and title blocks → Extra instructions.</p>`],
  ["plants", "Plant library", `
    <p>Your plant graphics, each with its botanical name, common name and the code used on plans. On a job, each plant in the checklist is matched to a graphic:</p>
    <ul><li>by code (e.g. LT),</li><li>by botanical or common name,</li><li>then by species (a cultivar uses its species' graphic),</li><li>then by genus (flagged "genus only").</li></ul>
    <p>"No symbol" means you don't have that graphic yet. The leaf button on a job downloads the plant list with the matched graphics as a CSV. Species and genus matching can be switched off in Settings.</p>`],
  ["titleblock", "Title block for Illustrator", `
    <p>Each job's title block details (job number, project, client, address, scale, date, disclaimer, copyright and "drawn by") download from the job page:</p>
    <ul>
      <li><b>Variable library (XML):</b> in Illustrator, Window → Variables → panel menu → Load Variable Library. Bind each text box in your template to a variable once; after that every job fills in automatically.</li>
      <li><b>CSV:</b> the same data as a data set, for Variables → Import.</li>
    </ul>
    <p>The disclaimer comes from the client, or from your default in Settings. Keep the logo in your Illustrator template.</p>`],
  ["time", "Time and prices", `
    <p>You price by job size, not by the hour. To work out fair prices, time a few jobs: press play on a job to start the timer and stop when you finish, or add time by hand (e.g. "1:30").</p>
    <p>Settings → "How long jobs take" shows the average, shortest and longest time for each size, and what the price works out to per hour. Adjust the prices there.</p>`],
  ["invoices", "Invoices and GST", `
    <p>Press the invoice button on a job. The amount comes from the job's size price, and the next invoice number is used. It's saved as a draft; edit it, print or save it as a PDF, or email it to the client (replies come to your email).</p>
    <ul>
      <li><b>Mark as paid</b> with the tick on the Invoices page, or set the date paid when editing.</li>
      <li><b>Filters</b> show unpaid, overdue or paid invoices; the download button gives a CSV for your accountant.</li>
      <li><b>GST by quarter</b> at the bottom of the Invoices page adds up sales and GST for each BAS quarter, by invoice date or by date paid (choose in Settings).</li>
      <li><b>GST:</b> "Registered for GST" and "Add GST to invoices" are separate settings, and each invoice has its own GST switch. Registered businesses that add GST get a "Tax invoice".</li>
    </ul>`],
  ["settings", "Settings", `
    <p>Anything about how Sprigboard works for your business is in Settings, so you never need a programmer to change it: wording on invoices and emails, the GST rate, number formats, status names, plan-reading instructions, plant matching and your time zone.</p>
    <p>Owners can download all the data as a backup with the download button at the top of Settings.</p>`],
  ["signin", "Signing in and your account", `
    <ul>
      <li><b>Passkey</b> (recommended): add one on your Account page, then use "Sign in with a passkey". It uses your fingerprint, face or phone, with nothing to type.</li>
      <li><b>Password:</b> set or change it on your Account page.</li>
      <li><b>Email code:</b> "Email me a sign-in code" sends a 6-digit code that works for 10 minutes.</li>
      <li><b>Forgot your password?</b> sends a link to choose a new one.</li>
    </ul>
    <p>Lost a device? "Sign out everywhere" on the Account page signs out every browser, and you can remove its passkey there too. Owners can invite people from the Users page.</p>`],
];

export function helpBody(): string {
  const nav = SECTIONS.map(([id, title]) => `<a class="chip" href="#help-${id}">${esc(title)}</a>`).join("");
  const body = SECTIONS.map(([id, title, html]) => `<section class="panel help" id="help-${id}"><h2>${esc(title)}</h2>${html}</section>`).join("");
  return `<h1>Help</h1><p class="sub">How Sprigboard works, area by area.</p><nav class="chips" aria-label="Help topics">${nav}</nav>${body}`;
}
