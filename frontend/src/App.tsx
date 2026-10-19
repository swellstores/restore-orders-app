import DeletedOrders from './DeletedOrders';
import './App.css';

export default function App() {
  return <main>
    <h1>Restore orders</h1>
    <p>Find orders deleted in a period and restore them. Orders that exist again are not listed. Click an order to see its deleted event data.</p>
    <DeletedOrders />
  </main>;
}
