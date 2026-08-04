import { clerkClient, getAuth } from '@clerk/express';
import type { NextFunction, Request, Response } from 'express';

export function requireUser(req:Request,res:Response,next:NextFunction){
  if(!getAuth(req).isAuthenticated)return res.status(401).json({code:'AUTH_REQUIRED',message:'Sign in to continue.'});
  next();
}
export function requirePermission(permission:'org:rail:admin'|'org:rail:view'){
  return (req:Request,res:Response,next:NextFunction)=>{
    const auth=getAuth(req);
    if(!auth.isAuthenticated)return res.status(401).json({code:'AUTH_REQUIRED',message:'Sign in to continue.'});
    if(!auth.has({permission})&&!auth.has({permission:'org:rail:admin'}))return res.status(403).json({code:'FORBIDDEN',message:'You do not have permission to access this area.'});
    next();
  };
}
export async function identity(req:Request){
  const {userId}=getAuth(req); if(!userId)throw new Error('Unauthenticated');
  const user=await clerkClient.users.getUser(userId);
  const email=user.emailAddresses.find((x:{id:string;emailAddress:string})=>x.id===user.primaryEmailAddressId)?.emailAddress??user.emailAddresses[0]?.emailAddress;
  if(!email)throw new Error('Authenticated account has no email');
  const name=[user.firstName,user.lastName].filter(Boolean).join(' ')||email.split('@')[0];
  return {userId,email,name};
}
