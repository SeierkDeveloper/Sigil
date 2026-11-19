import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page">
      <div className="container container-narrow">
        <header className="page-header">
          <p className="eyebrow">Not found</p>
          <h1 className="page-title">There is nothing here</h1>
          <p className="page-lead">The page you asked for does not exist or has moved.</p>
        </header>
        <div className="row">
          <Link href="/" className="button button-primary">
            Go to the home page
          </Link>
          <Link href="/docs" className="button">
            Read the docs
          </Link>
        </div>
      </div>
    </div>
  );
}
