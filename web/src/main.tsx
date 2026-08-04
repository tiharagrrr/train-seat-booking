import React from 'react';
import {createRoot} from 'react-dom/client';
import {ClerkProvider} from '@clerk/react';
import {App} from './App';
import './styles.css';

const clerkPublishableKey=import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if(!clerkPublishableKey)throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required');

class ErrorBoundary extends React.Component<React.PropsWithChildren,{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return{failed:true}}
 render(){return this.state.failed?<main className="fatal"><h1>Something went wrong</h1><p>Your booking has not been changed. Reload the page or try again shortly.</p><button onClick={()=>location.reload()}>Reload</button></main>:this.props.children}
}
createRoot(document.getElementById('root')!).render(<ClerkProvider publishableKey={clerkPublishableKey}><ErrorBoundary><App/></ErrorBoundary></ClerkProvider>);
