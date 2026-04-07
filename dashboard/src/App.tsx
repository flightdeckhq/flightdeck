import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Fleet } from "@/pages/Fleet";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Fleet />} />
      </Routes>
    </BrowserRouter>
  );
}
