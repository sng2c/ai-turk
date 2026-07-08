import * as React from "react";
import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("bg-card text-card-foreground flex flex-col gap-6 border py-6 shadow-sm", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("grid auto-rows-min gap-1.5 px-6", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("leading-none font-semibold", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
	return <div className={cn("flex items-center px-6", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardContent, CardFooter };