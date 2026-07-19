import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletProviders } from "@/components/WalletProviders";
import { Analytics } from "@vercel/analytics/next";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://tornaline.vercel.app"),
  title: "TornaLine — on-chain prediction markets, settled on TxLINE proofs",
  description:
    "TornaLine is an on-chain prediction market for live World Cup football. Trade outcome shares on a parallel order book; when the match ends, anyone settles the market trustlessly — TxLINE's oracle verifies a Merkle proof of the result on-chain, with no admin. Built on Torna.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=clash-grotesk@300,400,500,600,700&display=swap"
        />
      </head>
      <body className="flex min-h-full flex-col">
        <WalletProviders>
          <Nav />
          <main className="flex-1">{children}</main>
          <Footer />
        </WalletProviders>
        <Analytics />
      </body>
    </html>
  );
}
